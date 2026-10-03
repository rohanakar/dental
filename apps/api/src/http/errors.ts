import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { ApiError } from '@dcad/shared';
import { DomainError, type DomainErrorCode } from '../domain/errors';
import type { AppEnv } from './types';

const STATUS: Record<DomainErrorCode, ContentfulStatusCode> = {
  validation_error: 400,
  invalid_encoding: 400,
  unauthorized: 401,
  no_organization: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  integrity_error: 422,
  rate_limited: 429,
  not_implemented: 501,
  upstream_error: 502,
};

const body = (code: string, message: string, details?: unknown): ApiError => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

export function handleError(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof DomainError) {
    const status = STATUS[err.code];
    if (err.code === 'rate_limited') {
      const retry = (err.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
      if (retry) c.header('Retry-After', String(retry));
    }
    return c.json(body(err.code, err.message, err.details), status);
  }
  if (err instanceof ZodError) {
    return c.json(
      body(
        'validation_error',
        'Request validation failed',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
      400,
    );
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    const code = status === 413 ? 'payload_too_large' : status === 401 ? 'unauthorized' : 'http_error';
    return c.json(body(code, err.message || 'Request failed'), status);
  }
  c.get('log')?.error({ err }, 'unhandled error');
  return c.json(body('internal_error', 'Internal server error'), 500);
}
