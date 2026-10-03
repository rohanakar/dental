import { z } from 'zod';

/**
 * Provider-agnostic LLM wire format between the browser (which runs the
 * agent tool loop) and the API proxy (which holds keys and talks to
 * Anthropic / OpenAI). Adapters on the server translate to each provider.
 */

export const LlmTextPart = z.object({ type: z.literal('text'), text: z.string() });
export const LlmImagePart = z.object({
  type: z.literal('image'),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dataBase64: z.string(),
});
export const LlmToolCallPart = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export const LlmToolResultPart = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
});
export const LlmContentPart = z.discriminatedUnion('type', [LlmTextPart, LlmImagePart, LlmToolCallPart, LlmToolResultPart]);
export type LlmContentPart = z.infer<typeof LlmContentPart>;

export const LlmMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(LlmContentPart).min(1),
});
export type LlmMessage = z.infer<typeof LlmMessage>;

/** JSON Schema object describing a tool's input. */
export const LlmToolDef = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type LlmToolDef = z.infer<typeof LlmToolDef>;

/** The server picks provider + model per purpose from its config/allowlist. */
export const LlmPurpose = z.enum(['agent', 'rx-intake']);
export type LlmPurpose = z.infer<typeof LlmPurpose>;

export const LlmRequest = z.object({
  purpose: LlmPurpose,
  system: z.string().max(20_000).optional(),
  messages: z.array(LlmMessage).min(1).max(200),
  tools: z.array(LlmToolDef).max(64).optional(),
  maxTokens: z.number().int().min(1).max(16_000).default(2048),
});
export type LlmRequest = z.infer<typeof LlmRequest>;

export const LlmStopReason = z.enum(['end', 'tool_use', 'max_tokens', 'other']);

export const LlmResponse = z.object({
  provider: z.string(),
  model: z.string(),
  content: z.array(LlmContentPart),
  stopReason: LlmStopReason,
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
});
export type LlmResponse = z.infer<typeof LlmResponse>;
