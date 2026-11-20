import { describe, expect, it } from 'vitest';
import { FeedbackRequest } from '@dcad/shared';
import { MemoryRateLimiter } from '../src/adapters/rate-limit/memory';
import { FeedbackService } from '../src/domain/feedback';
import type { FeedbackRecord } from '../src/ports/repositories';

describe('feedback', () => {
  it('stores a message with or without a session, rejects a bad body, and limits one address', async () => {
    const rows: FeedbackRecord[] = [];
    let n = 0;
    const service = new FeedbackService({ insert: async (r) => void rows.push(r) }, new MemoryRateLimiter(5, 3_600_000), () => `f${++n}`);

    await service.submit({ ip: '1.1.1.1' }, FeedbackRequest.parse({ message: 'The margin snapped well', email: '' }));
    await service.submit({ ip: '1.1.1.1', user: { userId: 'u1', orgId: 'o1' } }, FeedbackRequest.parse({ message: 'Export was slow', email: 'a@lab.com' }));
    expect(rows.map((r) => [r.userId, r.orgId, r.email])).toEqual([
      [null, null, null],
      ['u1', 'o1', 'a@lab.com'],
    ]);

    expect(FeedbackRequest.safeParse({ message: '   ' }).success).toBe(false);
    expect(FeedbackRequest.safeParse({ message: 'x'.repeat(2001) }).success).toBe(false);

    for (let i = 0; i < 3; i++) await service.submit({ ip: '1.1.1.1' }, { message: 'again' });
    await expect(service.submit({ ip: '1.1.1.1' }, { message: 'sixth' })).rejects.toMatchObject({ code: 'rate_limited' });
    await service.submit({ ip: '2.2.2.2' }, { message: 'someone else' });
    expect(rows).toHaveLength(6);
  });
});
