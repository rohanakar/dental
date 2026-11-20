import type { FeedbackRequest } from '@dcad/shared';
import type { RateLimiter } from '../ports/llm';
import type { FeedbackRepository } from '../ports/repositories';
import { DomainError } from './errors';

export interface FeedbackSender {
  /** The caller's address, for the rate limit. */
  ip: string;
  userAgent?: string;
  /** Present when the sender has a session. */
  user?: { userId: string; orgId: string | null };
}

/** Beta feedback, stored for the owner to read. Anyone may send it, so each address is rate-limited. */
export class FeedbackService {
  constructor(
    private readonly feedback: FeedbackRepository,
    private readonly limiter: RateLimiter,
    private readonly newId: () => string,
  ) {}

  async submit(sender: FeedbackSender, input: FeedbackRequest): Promise<{ id: string }> {
    const { allowed, retryAfterSec } = this.limiter.consume(sender.ip);
    if (!allowed) throw new DomainError('rate_limited', 'Too much feedback from this address; try again later', { retryAfterSec });
    const id = this.newId();
    await this.feedback.insert({
      id,
      orgId: sender.user?.orgId ?? null,
      userId: sender.user?.userId ?? null,
      email: input.email ?? null,
      message: input.message,
      page: input.page ?? null,
      userAgent: sender.userAgent?.slice(0, 300) ?? null,
    });
    return { id };
  }
}
