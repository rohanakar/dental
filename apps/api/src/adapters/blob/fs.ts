import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobObject, BlobPutOptions, BlobStore } from '../../ports/blob-store';

const KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Local filesystem blob store (a Docker volume on the VM). Writes are atomic via temp file + rename. */
export class FsBlobStore implements BlobStore {
  readonly driver = 'fs';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    if (!KEY.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
      throw new Error(`Invalid blob key: ${key}`);
    }
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`Blob key escapes root: ${key}`);
    return full;
  }

  async put(key: string, body: Readable, _options?: BlobPutOptions): Promise<{ bytes: number }> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await pipeline(body, createWriteStream(temp, { flags: 'wx' }));
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return { bytes: (await stat(target)).size };
  }

  async get(key: string): Promise<BlobObject | null> {
    const head = await this.head(key);
    if (!head) return null;
    return { body: createReadStream(this.pathFor(key)), bytes: head.bytes };
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() ? { bytes: info.size } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
