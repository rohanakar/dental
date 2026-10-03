import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { BlobObject, BlobPutOptions, BlobStore } from '../../ports/blob-store';

export interface S3BlobStoreOptions {
  /** Custom endpoint for S3-compatible stores (OCI Object Storage, MinIO, R2). Omit for AWS. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Optional key prefix inside the bucket. */
  prefix?: string;
}

class Counter extends Transform {
  bytes = 0;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

const isNotFound = (err: unknown) =>
  err instanceof NoSuchKey ||
  err instanceof NotFound ||
  (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;

/** S3 API blob store: AWS S3, OCI Object Storage (S3 compatibility), Cloudflare R2, MinIO. */
export class S3BlobStore implements BlobStore {
  readonly driver = 's3';
  readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3BlobStoreOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Some S3-compatible stores (incl. OCI) reject the newer default checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.bucket = options.bucket;
    this.prefix = options.prefix ? options.prefix.replace(/\/?$/, '/') : '';
  }

  private key(key: string): string {
    return this.prefix + key;
  }

  async put(key: string, body: Readable, options: BlobPutOptions): Promise<{ bytes: number }> {
    const counter = new Counter();
    body.on('error', (err) => counter.destroy(err));
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.key(key),
        Body: body.pipe(counter),
        ContentType: options.contentType,
        Metadata: options.contentEncoding ? { 'dcad-encoding': options.contentEncoding } : undefined,
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
    return { bytes: counter.bytes };
  }

  async get(key: string): Promise<BlobObject | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      if (!out.Body) return null;
      return { body: out.Body as Readable, bytes: out.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return { bytes: out.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }
}
