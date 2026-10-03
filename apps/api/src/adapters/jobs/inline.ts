import type { JobQueue } from '../../ports/jobs';
import { DomainError } from '../../domain/errors';

/**
 * MVP job queue: no server-side proposers yet (classical proposers run in the
 * browser). Replace with a pg-boss / SQS adapter when ml.* proposers arrive.
 */
export class InlineJobQueue implements JobQueue {
  readonly available = false;

  private unavailable(): never {
    throw new DomainError(
      'not_implemented',
      'Server-side proposers are not available yet; classical proposers run in the browser',
    );
  }

  async enqueue(): Promise<never> {
    this.unavailable();
  }

  async get(): Promise<never> {
    this.unavailable();
  }

  async cancel(): Promise<never> {
    this.unavailable();
  }
}
