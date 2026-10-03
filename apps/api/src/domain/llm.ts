import type { LlmPurpose, LlmRequest, LlmResponse } from '@dcad/shared';
import type { AuthContext } from '../ports/auth';
import type { LlmProvider, RateLimiter } from '../ports/llm';
import type { LlmUsageRepository } from '../ports/repositories';
import { DomainError } from './errors';

export interface LlmRouteTable {
  routes: Record<LlmPurpose, { provider: string; model: string }>;
}

/**
 * Thin proxy: the browser runs the agent tool loop; the server holds keys,
 * picks provider + model per purpose (clients cannot choose), rate-limits,
 * and records usage.
 */
export class LlmService {
  constructor(
    private readonly providers: Record<string, LlmProvider>,
    private readonly table: LlmRouteTable,
    private readonly limiter: RateLimiter,
    private readonly usage: LlmUsageRepository,
  ) {}

  async complete(ctx: AuthContext, request: LlmRequest): Promise<LlmResponse> {
    const verdict = this.limiter.consume(ctx.userId);
    if (!verdict.allowed) {
      throw new DomainError('rate_limited', 'Too many LLM requests; slow down', {
        retryAfterSec: verdict.retryAfterSec,
      });
    }
    const route = this.table.routes[request.purpose];
    const provider = this.providers[route.provider];
    if (!provider) throw new DomainError('not_implemented', `LLM provider "${route.provider}" is not configured`);

    let response: LlmResponse;
    try {
      response = await provider.complete({
        model: route.model,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        maxTokens: request.maxTokens,
      });
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError('upstream_error', `LLM provider error: ${(err as Error).message}`);
    }

    await this.usage.insert({
      orgId: ctx.orgId,
      userId: ctx.userId,
      purpose: request.purpose,
      provider: response.provider,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    return response;
  }
}
