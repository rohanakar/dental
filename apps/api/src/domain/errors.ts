export type DomainErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'no_organization'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'integrity_error'
  | 'invalid_encoding'
  | 'rate_limited'
  | 'not_implemented'
  | 'upstream_error';

/** Errors the HTTP layer maps to status codes and ApiError bodies. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string) => new DomainError('not_found', `${what} not found`);
