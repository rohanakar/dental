import { Hono, type MiddlewareHandler } from 'hono';
import { type CaseDetail, CreateCaseRequest, SaveVersionRequest, UpdateCaseRequest } from '@dcad/shared';
import type { Services } from '../app';
import type { AppEnv } from '../types';
import { readJson } from '../validate';

export function caseRoutes(services: Services, jsonLimit: MiddlewareHandler): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/cases', async (c) => c.json(await services.cases.list(c.get('auth'))));

  r.post('/cases', jsonLimit, async (c) => {
    const input = await readJson(c, CreateCaseRequest);
    return c.json(await services.cases.create(c.get('auth'), input), 201);
  });

  r.get('/cases/:id', async (c) => {
    const ctx = c.get('auth');
    const found = await services.cases.get(ctx, c.req.param('id'));
    const files = await services.files.listForCase(ctx, found.id);
    return c.json({ ...found, files } satisfies CaseDetail);
  });

  r.patch('/cases/:id', jsonLimit, async (c) => {
    const patch = await readJson(c, UpdateCaseRequest);
    return c.json(await services.cases.update(c.get('auth'), c.req.param('id'), patch));
  });

  r.post('/cases/:id/versions', jsonLimit, async (c) => {
    const request = await readJson(c, SaveVersionRequest);
    return c.json(await services.versions.save(c.get('auth'), c.req.param('id'), request), 201);
  });

  r.get('/cases/:id/versions/latest', async (c) =>
    c.json(await services.versions.latest(c.get('auth'), c.req.param('id'))),
  );

  return r;
}
