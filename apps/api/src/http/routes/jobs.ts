import { Hono, type MiddlewareHandler } from 'hono';
import { ProposalJobRequest } from '@dcad/shared';
import type { Services } from '../app';
import type { AppEnv } from '../types';
import { readJson } from '../validate';

/** Server-side proposer jobs (future ml.* proposers). The MVP queue answers 501. */
export function jobRoutes(services: Services, jsonLimit: MiddlewareHandler): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/jobs', jsonLimit, async (c) => {
    const request = await readJson(c, ProposalJobRequest);
    return c.json(await services.jobs.enqueue(c.get('auth').orgId, request), 202);
  });
  r.get('/jobs/:id', async (c) => {
    const status = await services.jobs.get(c.get('auth').orgId, c.req.param('id'));
    return status ? c.json(status) : c.json({ error: { code: 'not_found', message: 'Job not found' } }, 404);
  });
  r.delete('/jobs/:id', async (c) => {
    await services.jobs.cancel(c.get('auth').orgId, c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}
