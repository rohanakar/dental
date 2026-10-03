import type { Context } from 'hono';
import type { z } from 'zod';
import { DomainError } from '../domain/errors';

/** Parse and validate a JSON body; ZodErrors become 400 validation_error via the error handler. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new DomainError('validation_error', 'Request body must be valid JSON');
  }
  return schema.parse(raw);
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return schema.parse(c.req.query());
}
