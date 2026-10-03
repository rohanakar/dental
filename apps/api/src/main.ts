import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import pino from 'pino';
import { createBetterAuth } from './adapters/auth/better-auth';
import { FsBlobStore } from './adapters/blob/fs';
import { S3BlobStore } from './adapters/blob/s3';
import { createDb } from './adapters/db/client';
import { runMigrations } from './adapters/db/migrate';
import { createRepositories } from './adapters/db/repos';
import { InlineJobQueue } from './adapters/jobs/inline';
import { createLlmProviders } from './adapters/llm';
import { MemoryRateLimiter } from './adapters/rate-limit/memory';
import { loadConfig } from './config';
import { LlmService } from './domain/llm';
import { createApp } from './http/app';
import type { BlobStore } from './ports/blob-store';

const config = loadConfig();
const logger = pino({ level: config.logLevel, base: { service: 'dcad-api' } });

const dbHandle = createDb(config.databaseUrl);
if (config.migrateOnStart) {
  await runMigrations(dbHandle.db, config.migrationsDir);
  logger.info({ dir: config.migrationsDir }, 'migrations applied');
}

let blobs: BlobStore;
if (config.blob.driver === 's3') {
  blobs = new S3BlobStore(config.blob);
} else {
  await mkdir(config.blob.root, { recursive: true });
  blobs = new FsBlobStore(config.blob.root);
}

const { port: auth } = createBetterAuth({
  db: dbHandle.db,
  secret: config.auth.secret,
  publicUrl: config.publicUrl,
  publicOrigin: config.publicOrigin,
  basePath: config.basePath,
  trustedOrigins: config.auth.trustedOrigins,
  production: config.env === 'production',
});

for (const warning of config.llm.warnings) logger.warn(warning);
for (const [purpose, route] of Object.entries(config.llm.routes)) {
  logger.info({ purpose, provider: route.provider, model: route.model }, 'llm route');
}

const repos = createRepositories(dbHandle.db);
const llm = new LlmService(
  createLlmProviders(config.llm),
  { routes: config.llm.routes },
  new MemoryRateLimiter(config.llm.rateLimitPerMin),
  repos.llmUsage,
);

const app = createApp({
  logger,
  auth,
  repos,
  blobs,
  jobs: new InlineJobQueue(),
  llm,
  limits: config.limits,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  logger.info(
    { port: info.port, publicUrl: config.publicUrl, basePath: config.basePath || '/', blob: blobs.driver },
    'dcad api listening',
  );
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await dbHandle.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
