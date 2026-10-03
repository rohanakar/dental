import { Hono, type MiddlewareHandler } from 'hono';
import { ProposalEvent } from '@dcad/shared';
import type { Services } from '../app';
import type { AppEnv } from '../types';
import { readJson } from '../validate';

export function proposalEventRoutes(services: Services, jsonLimit: MiddlewareHandler): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/proposal-events', jsonLimit, async (c) => {
    const event = await readJson(c, ProposalEvent);
    return c.json(await services.proposalEvents.record(c.get('auth'), event), 201);
  });
  return r;
}
