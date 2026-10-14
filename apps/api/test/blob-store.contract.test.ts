import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsBlobStore } from '../src/adapters/blob/fs';
import { S3BlobStore } from '../src/adapters/blob/s3';
import type { BlobStore } from '../src/ports/blob-store';
import { TEST_INFRA, TEST_S3 } from './helpers';

interface Harness {
  store: BlobStore;
  cleanup(): Promise<void>;
  /** Number of stored objects, to assert failed writes leave nothing behind. */
  count(): Promise<number>;
}

const opts = { contentType: 'application/octet-stream' };

function failingStream(): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(randomBytes(1024));
      } else {
        this.destroy(new Error('client went away'));
      }
    },
  });
}

/**
 * The same suite runs against every adapter: if it passes, swapping
 * BLOB_DRIVER is a configuration change.
 */
function blobStoreContract(name: string, make: () => Promise<Harness>, enabled = true) {
  describe.skipIf(!enabled)(`BlobStore contract: ${name}`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await make();
    });
    afterAll(async () => {
      await h?.cleanup();
    });

    it('round-trips a streamed object and reports its size', async () => {
      const data = randomBytes(3 * 1024 * 1024 + 17);
      const { bytes } = await h.store.put('orgs/o1/cases/c1/a', Readable.from([data.subarray(0, 1000), data.subarray(1000)]), opts);
      expect(bytes).toBe(data.length);
      const obj = await h.store.get('orgs/o1/cases/c1/a');
      expect(obj).not.toBeNull();
      expect(obj!.bytes).toBe(data.length);
      expect((await buffer(obj!.body)).equals(data)).toBe(true);
      expect(await h.store.head('orgs/o1/cases/c1/a')).toEqual({ bytes: data.length });
    });

    it('returns null for missing objects', async () => {
      expect(await h.store.get('orgs/o1/missing')).toBeNull();
      expect(await h.store.head('orgs/o1/missing')).toBeNull();
    });

    it('rejects a failing upload stream and stores nothing', async () => {
      const before = await h.count();
      await expect(h.store.put('orgs/o1/broken', failingStream(), opts)).rejects.toThrow();
      expect(await h.store.head('orgs/o1/broken')).toBeNull();
      expect(await h.count()).toBe(before);
    });
  });
}

async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).length;
}

blobStoreContract('fs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcad-blob-contract-'));
  return {
    store: new FsBlobStore(root),
    count: () => countFiles(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

blobStoreContract(
  's3 (SeaweedFS from infra/docker-compose.test.yml)',
  async () => {
    const bucket = `dcad-contract-${randomUUID().slice(0, 8)}`;
    const store = new S3BlobStore({ ...TEST_S3, bucket });
    await store.client.send(new CreateBucketCommand({ Bucket: bucket }));
    const list = async () => (await store.client.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents ?? [];
    return {
      store,
      count: async () => (await list()).length,
      cleanup: async () => {
        for (const obj of await list()) await store.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key! }));
        await store.client.send(new DeleteBucketCommand({ Bucket: bucket }));
      },
    };
  },
  TEST_INFRA,
);

describe('FsBlobStore key safety', () => {
  it('rejects keys that escape the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dcad-blob-keys-'));
    const store = new FsBlobStore(root);
    await expect(store.put('../evil', Readable.from([Buffer.from('x')]), opts)).rejects.toThrow(/Invalid blob key/);
    await expect(store.head('a/../../evil')).rejects.toThrow(/Invalid blob key/);
    await rm(root, { recursive: true, force: true });
  });
});
