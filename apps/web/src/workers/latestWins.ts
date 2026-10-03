/**
 * Comlink calls cannot be cancelled, so long-running worker calls use
 * "latest wins": each call for a key gets a generation number, and results
 * from superseded generations are discarded with StaleResultError.
 */
export class StaleResultError extends Error {
  constructor(key: string) {
    super(`Result for "${key}" was superseded by a newer request`);
    this.name = 'StaleResultError';
  }
}

export class LatestWins {
  private readonly generations = new Map<string, number>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const result = await task();
    if (this.generations.get(key) !== generation) throw new StaleResultError(key);
    return result;
  }

  /** Invalidate any in-flight call for the key (e.g. when the object is removed). */
  cancel(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }
}

export const isStale = (e: unknown): e is StaleResultError => e instanceof StaleResultError;
