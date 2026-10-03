import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import type { Hono } from 'hono';
import { createBetterAuth } from '../src/adapters/auth/better-auth';
import { FsBlobStore } from '../src/adapters/blob/fs';
import { createDb, type DbHandle } from '../src/adapters/db/client';
import { runMigrations } from '../src/adapters/db/migrate';
import { createRepositories } from '../src/adapters/db/repos';
import { InlineJobQueue } from '../src/adapters/jobs/inline';
import { MockLlmProvider } from '../src/adapters/llm/mock';
import { MemoryRateLimiter } from '../src/adapters/rate-limit/memory';
import { LlmService } from '../src/domain/llm';
import { createApp } from '../src/http/app';
import type { AppEnv } from '../src/http/types';

/** Integration suites need `docker compose -f infra/docker-compose.test.yml up -d --wait` and TEST_INFRA=1. */
export const TEST_INFRA = process.env.TEST_INFRA === '1';
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dcad:dcad@127.0.0.1:55432/dcad_test';
export const TEST_S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:58333',
  region: 'us-east-1',
  accessKeyId: 'dcadtest',
  secretAccessKey: 'dcadtest-secret',
  forcePathStyle: true,
};
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'drizzle');

export async function resetDatabase(url = TEST_DATABASE_URL): Promise<void> {
  const handle = createDb(url, { max: 1 });
  try {
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    await handle.db.execute(sql`create schema public`);
    await runMigrations(handle.db, MIGRATIONS_DIR);
  } finally {
    await handle.close();
  }
}

export interface TestApp {
  app: Hono<AppEnv>;
  db: DbHandle;
  blobRoot: string;
  origin: string;
  close(): Promise<void>;
}

export async function buildTestApp(options: { publicUrl?: string; maxUploadBytes?: number } = {}): Promise<TestApp> {
  const publicUrl = options.publicUrl ?? 'http://localhost:8080';
  const url = new URL(publicUrl);
  const db = createDb(TEST_DATABASE_URL, { max: 4 });
  const blobRoot = await mkdtemp(join(tmpdir(), 'dcad-blobs-'));
  const { port: auth } = createBetterAuth({
    db: db.db,
    secret: 'test-secret-test-secret-test-secret-1234',
    publicUrl,
    publicOrigin: url.origin,
    basePath: url.pathname.replace(/\/+$/, ''),
    trustedOrigins: [],
    production: false,
  });
  const repos = createRepositories(db.db);
  const llm = new LlmService(
    { mock: new MockLlmProvider() },
    {
      routes: {
        agent: { provider: 'mock', model: 'mock-1' },
        'rx-intake': { provider: 'mock', model: 'mock-1' },
      },
    },
    new MemoryRateLimiter(1000),
    repos.llmUsage,
  );
  const app = createApp({
    logger: pino({ level: 'silent' }),
    auth,
    repos,
    blobs: new FsBlobStore(blobRoot),
    jobs: new InlineJobQueue(),
    llm,
    limits: { maxUploadBytes: options.maxUploadBytes ?? 2 * 1024 * 1024, maxJsonBytes: 1024 * 1024 },
  });
  return {
    app,
    db,
    blobRoot,
    origin: url.origin,
    async close() {
      await db.close();
      await rm(blobRoot, { recursive: true, force: true });
    },
  };
}

/** Collect Set-Cookie headers into a Cookie request header. */
export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ');
}

export async function signUp(t: TestApp, email: string, name = 'Test User'): Promise<{ cookie: string; res: Response }> {
  const res = await t.app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: t.origin },
    body: JSON.stringify({ email, password: 'correct-horse-battery', name }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return { cookie: cookieHeader(res), res };
}

export async function signIn(t: TestApp, email: string): Promise<{ cookie: string; res: Response }> {
  const res = await t.app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: t.origin },
    body: JSON.stringify({ email, password: 'correct-horse-battery' }),
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  return { cookie: cookieHeader(res), res };
}

export function authed(t: TestApp, cookie: string) {
  return (path: string, init: RequestInit = {}) =>
    t.app.request(path, {
      ...init,
      headers: { origin: t.origin, cookie, ...(init.headers as Record<string, string> | undefined) },
    });
}
