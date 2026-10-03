import OpenAI from 'openai';
import type { LlmContentPart, LlmResponse } from '@dcad/shared';
import type { LlmCompletionRequest, LlmProvider } from '../../ports/llm';
import { toOpenAiStrictSchema } from './openai-strict';

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UserPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

export function toOpenAiRequest(request: LlmCompletionRequest): ChatParams {
  const messages: ChatMessage[] = [];
  if (request.system) messages.push({ role: 'system', content: request.system });

  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((p): p is Extract<LlmContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const toolCalls = message.content
        .filter((p): p is Extract<LlmContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
        .map((p) => ({
          id: p.id,
          type: 'function' as const,
          function: { name: p.name, arguments: JSON.stringify(p.input) },
        }));
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // User turn: tool results become separate `tool` messages (they must
    // directly follow the assistant tool_calls); text/images form one user message.
    const userParts: UserPart[] = [];
    for (const part of message.content) {
      if (part.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: part.isError ? `ERROR: ${part.content}` : part.content,
        });
      } else if (part.type === 'text') {
        userParts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        userParts.push({ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` } });
      }
    }
    if (userParts.length) messages.push({ role: 'user', content: userParts });
  }

  return {
    model: request.model,
    messages,
    max_completion_tokens: request.maxTokens,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: toOpenAiStrictSchema(t.inputSchema),
              strict: true,
            },
          })),
        }
      : {}),
  };
}

const FINISH_REASONS: Record<string, LlmResponse['stopReason']> = {
  stop: 'end',
  tool_calls: 'tool_use',
  length: 'max_tokens',
};

/** Strict mode sends optional fields as null; drop them so zod sees them as absent. */
function dropNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
}

export function fromOpenAiCompletion(completion: OpenAI.Chat.Completions.ChatCompletion): LlmResponse {
  const choice = completion.choices[0];
  const content: LlmContentPart[] = [];
  if (choice?.message.content) content.push({ type: 'text', text: choice.message.content });
  for (const call of choice?.message.tool_calls ?? []) {
    if (call.type !== 'function') continue;
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      input = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? dropNulls(parsed as Record<string, unknown>) : {};
    } catch {
      input = { _unparseableArguments: call.function.arguments };
    }
    content.push({ type: 'tool_call', id: call.id, name: call.function.name, input });
  }
  return {
    provider: 'openai',
    model: completion.model,
    content,
    stopReason: FINISH_REASONS[choice?.finish_reason ?? ''] ?? 'other',
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 2, timeout: 120_000 });
  }

  async complete(request: LlmCompletionRequest): Promise<LlmResponse> {
    const completion = await this.client.chat.completions.create(toOpenAiRequest(request));
    return fromOpenAiCompletion(completion);
  }
}
