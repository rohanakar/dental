import type { Readable } from 'node:stream';

export interface BlobPutOptions {
  contentType: string;
  /** Stored as metadata where the backend supports it; the DB is the source of truth. */
  contentEncoding?: 'identity' | 'gzip';
}

export interface BlobObject {
  body: Readable;
  bytes: number;
}

/**
 * Object storage port. Keys are slash-separated relative paths
 * (e.g. "orgs/<org>/cases/<case>/<file>"). Implementations: fs, s3.
 */
export interface BlobStore {
  readonly driver: string;
  /** Stream `body` into `key`, replacing any existing object. Resolves with the stored byte count. */
  put(key: string, body: Readable, options: BlobPutOptions): Promise<{ bytes: number }>;
  /** Returns null if the object does not exist. */
  get(key: string): Promise<BlobObject | null>;
  head(key: string): Promise<{ bytes: number } | null>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
