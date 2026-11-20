import { FeedbackRequest } from '@dcad/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AuthPort } from '../../ports/auth';
import type { Services } from '../app';
import type { AppEnv } from '../types';
import { readJson } from '../validate';

/** Open to visitors without an account; mounted before the session check. A session, when there is one, is recorded. */
export function feedbackRoutes(services: Services, auth: AuthPort, jsonLimit: MiddlewareHandler): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/feedback', jsonLimit, async (c) => {
    const input = await readJson(c, FeedbackRequest);
    const resolved = await auth.resolve(c.req.raw.headers).catch(() => null);
    // Caddy and Nginx Proxy Manager put the client first in X-Forwarded-For.
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const sent = await services.feedback.submit(
      { ip, userAgent: c.req.header('user-agent'), user: resolved ? { userId: resolved.userId, orgId: resolved.orgId } : undefined },
      input,
    );
    return c.json(sent, 201);
  });
  return r;
}
