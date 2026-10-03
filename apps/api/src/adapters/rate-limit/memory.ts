import type { RateLimiter } from '../../ports/llm';

/**
 * Fixed-window in-memory limiter. Fine for a single API instance; swap for a
 * Postgres/Redis-backed limiter when running more than one replica.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    let window = this.windows.get(key);
    if (!window || t - window.start >= this.windowMs) {
      window = { start: t, count: 0 };
      this.windows.set(key, window);
      if (this.windows.size > 10_000) this.evict(t);
    }
    window.count += 1;
    const allowed = window.count <= this.limit;
    return { allowed, retryAfterSec: allowed ? 0 : Math.ceil((window.start + this.windowMs - t) / 1000) };
  }

  private evict(t: number): void {
    for (const [key, window] of this.windows) {
      if (t - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
