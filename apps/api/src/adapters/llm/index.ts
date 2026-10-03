import type { Config } from '../../config';
import type { LlmProvider } from '../../ports/llm';
import { AnthropicProvider } from './anthropic';
import { MockLlmProvider } from './mock';
import { OpenAiProvider } from './openai';

/** Instantiate only the providers that the configured routes use. */
export function createLlmProviders(config: Config['llm']): Record<string, LlmProvider> {
  const used = new Set(Object.values(config.routes).map((r) => r.provider));
  const providers: Record<string, LlmProvider> = {};
  if (used.has('anthropic') && config.anthropicApiKey) providers.anthropic = new AnthropicProvider(config.anthropicApiKey);
  if (used.has('openai') && config.openaiApiKey) providers.openai = new OpenAiProvider(config.openaiApiKey, config.openaiBaseUrl);
  if (used.has('mock')) providers.mock = new MockLlmProvider();
  return providers;
}
