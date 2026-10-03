import type { LlmMessage, LlmResponse, LlmToolDef } from '@dcad/shared';

export interface LlmCompletionRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  maxTokens: number;
}

/** One adapter per provider (anthropic, openai, mock). */
export interface LlmProvider {
  readonly name: string;
  complete(request: LlmCompletionRequest): Promise<LlmResponse>;
}

export interface RateLimiter {
  /** Consume one unit for `key`. */
  consume(key: string): { allowed: boolean; retryAfterSec: number };
}
