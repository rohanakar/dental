import Anthropic from '@anthropic-ai/sdk';
import type { LlmContentPart, LlmMessage, LlmResponse } from '@dcad/shared';
import type { LlmCompletionRequest, LlmProvider } from '../../ports/llm';

type MessageCreateParams = Anthropic.MessageCreateParamsNonStreaming;
type ContentBlockParam = Anthropic.ContentBlockParam;

function toBlock(part: LlmContentPart): ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 } };
    case 'tool_call':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: part.content,
        ...(part.isError ? { is_error: true } : {}),
      };
  }
}

export function toAnthropicRequest(request: LlmCompletionRequest): MessageCreateParams {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    ...(request.system ? { system: request.system } : {}),
    messages: request.messages.map((m: LlmMessage) => ({ role: m.role, content: m.content.map(toBlock) })),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
  };
}

const STOP_REASONS: Record<string, LlmResponse['stopReason']> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
};

export function fromAnthropicMessage(message: Anthropic.Message): LlmResponse {
  const content: LlmContentPart[] = [];
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use') {
      content.push({ type: 'tool_call', id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
    }
    // thinking / server-tool blocks are not part of the proxy contract; drop them.
  }
  return {
    provider: 'anthropic',
    model: message.model,
    content,
    stopReason: STOP_REASONS[message.stop_reason ?? ''] ?? 'other',
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async complete(request: LlmCompletionRequest): Promise<LlmResponse> {
    const message = await this.client.messages.create(toAnthropicRequest(request));
    return fromAnthropicMessage(message);
  }
}
