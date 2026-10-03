import { createHash, type Hash } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, type Gunzip } from 'node:zlib';
import type { CaseFile, UploadFileQuery } from '@dcad/shared';
import type { AuthContext } from '../ports/auth';
import type { BlobStore } from '../ports/blob-store';
import type { CaseRepository, FileRecord, FileRepository } from '../ports/repositories';
import { DomainError, notFound } from './errors';

/** Gzip bombs: cap decompressed bytes at this multiple of the upload limit. */
const MAX_DECOMPRESSION_RATIO = 20;

/** Errors raised inside the stream chain, so the most meaningful one wins over generic stream errors. */
class FirstError {
  error: DomainError | undefined;
  record(error: DomainError): DomainError {
    this.error ??= error;
    return error;
  }
}

class ByteLimit extends Transform {
  bytes = 0;
  constructor(
    private readonly max: number,
    private readonly errors: FirstError,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.max) {
      cb(this.errors.record(new DomainError('payload_too_large', `Upload exceeds ${this.max} bytes`)));
      return;
    }
    cb(null, chunk);
  }
}

/** Passes bytes through unchanged while hashing them. */
class Sha256Tap extends Transform {
  private readonly hash: Hash = createHash('sha256');
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    cb(null, chunk);
  }
  digest(): string {
    return this.hash.digest('hex');
  }
}

/** Passes gzip bytes through unchanged while hashing their decompressed content. */
class GunzipSha256Tap extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private readonly gunzip: Gunzip = createGunzip();
  private decompressed = 0;
  private gunzipEnded: Promise<void>;

  constructor(maxDecompressed: number, errors: FirstError) {
    super();
    this.gunzip.on('data', (chunk: Buffer) => {
      this.decompressed += chunk.length;
      if (this.decompressed > maxDecompressed) {
        this.destroy(errors.record(new DomainError('payload_too_large', 'Decompressed upload is too large')));
        return;
      }
      this.hash.update(chunk);
    });
    this.gunzipEnded = new Promise((resolve, reject) => {
      this.gunzip.once('end', resolve);
      this.gunzip.once('error', (err) => {
        const domainError = errors.record(new DomainError('invalid_encoding', `Invalid gzip data: ${err.message}`));
        reject(domainError);
        this.destroy(domainError);
      });
    });
    this.gunzipEnded.catch(() => {}); // handled via destroy()
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.gunzip.write(chunk)) cb(null, chunk);
    else this.gunzip.once('drain', () => cb(null, chunk));
  }

  override _flush(cb: TransformCallback): void {
    this.gunzip.end();
    this.gunzipEnded.then(() => cb(), (err: Error) => cb(err));
  }

  override _destroy(error: Error | null, cb: (error?: Error | null) => void): void {
    this.gunzip.destroy();
    cb(error);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

const SAFE_CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export class FileService {
  constructor(
    private readonly cases: CaseRepository,
    private readonly files: FileRepository,
    private readonly blobs: BlobStore,
    private readonly newId: () => string,
    private readonly maxUploadBytes: number,
  ) {}

  /**
   * Stream an upload into blob storage without buffering it. The sha256 in
   * the query is of the uncompressed bytes and is verified while streaming;
   * on mismatch or any failure the blob is deleted.
   */
  async upload(
    ctx: AuthContext,
    caseId: string,
    query: UploadFileQuery,
    contentType: string | undefined,
    body: Readable,
  ): Promise<CaseFile> {
    const found = await this.cases.get(ctx.orgId, caseId);
    if (!found) {
      body.resume(); // drain so the connection can be reused
      throw notFound('Case');
    }

    const id = this.newId();
    const blobKey = `orgs/${ctx.orgId}/cases/${caseId}/${id}`;
    const type = contentType && SAFE_CONTENT_TYPE.test(contentType) ? contentType.toLowerCase() : 'application/octet-stream';
    const errors = new FirstError();
    const limiter = new ByteLimit(this.maxUploadBytes, errors);
    const tap =
      query.encoding === 'gzip'
        ? new GunzipSha256Tap(this.maxUploadBytes * MAX_DECOMPRESSION_RATIO, errors)
        : new Sha256Tap();

    let stored = 0;
    try {
      await pipeline(body, limiter, tap, async (source: AsyncIterable<Buffer>) => {
        const result = await this.blobs.put(blobKey, Readable.from(source), {
          contentType: type,
          contentEncoding: query.encoding,
        });
        stored = result.bytes;
      });
    } catch (err) {
      await this.blobs.delete(blobKey).catch(() => {});
      throw errors.error ?? err;
    }

    const actual = tap.digest();
    if (actual !== query.sha256) {
      await this.blobs.delete(blobKey).catch(() => {});
      throw new DomainError('integrity_error', 'sha256 of uploaded content does not match', {
        expected: query.sha256,
        actual,
      });
    }

    try {
      return toCaseFile(
        await this.files.insert({
          id,
          orgId: ctx.orgId,
          caseId,
          kind: query.kind,
          name: query.name,
          sha256: actual,
          bytes: stored,
          contentType: type,
          encoding: query.encoding,
          blobKey,
          createdBy: ctx.userId,
        }),
      );
    } catch (err) {
      await this.blobs.delete(blobKey).catch(() => {});
      throw err;
    }
  }

  async listForCase(ctx: AuthContext, caseId: string): Promise<CaseFile[]> {
    const found = await this.cases.get(ctx.orgId, caseId);
    if (!found) throw notFound('Case');
    return (await this.files.listForCase(ctx.orgId, caseId)).map(toCaseFile);
  }

  async open(ctx: AuthContext, fileId: string): Promise<{ file: CaseFile; body: Readable; bytes: number }> {
    const record = await this.files.get(ctx.orgId, fileId);
    if (!record) throw notFound('File');
    const object = await this.blobs.get(record.blobKey);
    if (!object) throw notFound('File content');
    return { file: toCaseFile(record), body: object.body, bytes: object.bytes };
  }
}

function toCaseFile(record: FileRecord): CaseFile {
  const { orgId: _org, blobKey: _key, ...file } = record;
  return file;
}
