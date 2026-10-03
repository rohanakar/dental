import { randomUUID } from 'node:crypto';
import type { Me } from '@dcad/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';
import { CaseService } from '../domain/cases';
import { DomainError } from '../domain/errors';
import { FileService } from '../domain/files';
import type { LlmService } from '../domain/llm';
import { ProposalEventService } from '../domain/proposal-events';
import { VersionService } from '../domain/versions';
import type { AuthPort } from '../ports/auth';
import type { BlobStore } from '../ports/blob-store';
import type { JobQueue } from '../ports/jobs';
import type { Repositories } from '../ports/repositories';
import { handleError } from './errors';
import { caseRoutes } from './routes/cases';
import { fileRoutes } from './routes/files';
import { jobRoutes } from './routes/jobs';
import { llmRoutes } from './routes/llm';
import { proposalEventRoutes } from './routes/proposal-events';
import type { AppEnv } from './types';

export interface AppDeps {
  logger: Logger;
  auth: AuthPort;
  repos: Repositories;
  blobs: BlobStore;
  jobs: JobQueue;
  llm: LlmService;
  limits: { maxUploadBytes: number; maxJsonBytes: number };
  newId?: () => string;
}

export interface Services {
  cases: CaseService;
  files: FileService;
  versions: VersionService;
  proposalEvents: ProposalEventService;
  llm: LlmService;
  jobs: JobQueue;
}

/**
 * Build the HTTP app from injected ports. Routes live under /api/* regardless
 * of the public sub-path (the reverse proxy strips it).
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const newId = deps.newId ?? randomUUID;
  const services: Services = {
    cases: new CaseService(deps.repos.cases, newId),
    files: new FileService(deps.repos.cases, deps.repos.files, deps.blobs, newId, deps.limits.maxUploadBytes),
    versions: new VersionService(deps.repos.versions),
    proposalEvents: new ProposalEventService(deps.repos.cases, deps.repos.proposalEvents, newId),
    llm: deps.llm,
    jobs: deps.jobs,
  };

  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  // Request id + structured access log.
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id')?.slice(0, 64) || randomUUID();
    const log = deps.logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('log', log);
    c.header('X-Request-Id', requestId);
    const started = performance.now();
    await next();
    const path = new URL(c.req.url).pathname;
    if (path === '/healthz') return;
    log.info({ method: c.req.method, path, status: c.res.status, ms: Math.round(performance.now() - started) }, 'request');
  });

  const health = async (c: { json: (body: unknown, status?: 200 | 503) => Response }) => {
    try {
      await deps.repos.health.ping();
      return c.json({ ok: true }, 200);
    } catch {
      return c.json({ ok: false }, 503);
    }
  };
  app.get('/healthz', (c) => health(c));
  app.get('/api/healthz', (c) => health(c));

  // Auth provider endpoints (sign-up, sign-in, sessions, organizations).
  app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw));

  // Everything else under /api requires a session with an organization.
  app.use('/api/*', async (c, next) => {
    const resolved = await deps.auth.resolve(c.req.raw.headers);
    if (!resolved) throw new DomainError('unauthorized', 'Sign in required');
    if (resolved.orgId === null) throw new DomainError('no_organization', 'User has no organization');
    c.set('auth', resolved);
    c.set('log', c.get('log').child({ userId: resolved.userId, orgId: resolved.orgId }));
    await next();
  });

  const jsonLimit = bodyLimit({
    maxSize: deps.limits.maxJsonBytes,
    onError: () => {
      throw new DomainError('payload_too_large', `JSON body exceeds ${deps.limits.maxJsonBytes} bytes`);
    },
  });

  app.get('/api/me', (c) => c.json(c.get('auth') satisfies Me));
  app.route('/api', caseRoutes(services, jsonLimit));
  app.route('/api', fileRoutes(services));
  app.route('/api', proposalEventRoutes(services, jsonLimit));
  app.route('/api', llmRoutes(services, jsonLimit));
  app.route('/api', jobRoutes(services, jsonLimit));

  return app;
}
