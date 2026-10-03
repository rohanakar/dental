import { Hono, type MiddlewareHandler } from 'hono';
import { LlmRequest } from '@dcad/shared';
import type { Services } from '../app';
import type { AppEnv } from '../types';
import { readJson } from '../validate';

/**
 * LLM proxy. The browser runs the agent tool loop and sends provider-agnostic
 * messages; the server picks provider + model by purpose and holds the keys.
 * Non-streaming for the MVP.
 */
export function llmRoutes(services: Services, jsonLimit: MiddlewareHandler): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/llm/messages', jsonLimit, async (c) => {
    const request = await readJson(c, LlmRequest);
    return c.json(await services.llm.complete(c.get('auth'), request));
  });
  return r;
}
