import type { LlmContentPart, LlmResponse } from '@dcad/shared';
import type { LlmCompletionRequest, LlmProvider } from '../../ports/llm';

/**
 * Deterministic offline provider for development and tests (used when no
 * API key is configured). If the last user text is `/tool <name> <json>`
 * and that tool was offered, it returns a tool call; otherwise it echoes.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  private calls = 0;

  async complete(request: LlmCompletionRequest): Promise<LlmResponse> {
    this.calls += 1;
    const last = request.messages[request.messages.length - 1];
    const text = last?.content.find((p): p is Extract<LlmContentPart, { type: 'text' }> => p.type === 'text')?.text ?? '';
    const sawToolResult = last?.content.some((p) => p.type === 'tool_result') ?? false;
    const chars = JSON.stringify(request.messages).length + (request.system?.length ?? 0);
    const usage = { inputTokens: Math.ceil(chars / 4), outputTokens: 16 };

    const toolMatch = /^\/tool\s+([a-z0-9_]+)\s*(\{.*\})?\s*$/s.exec(text.trim());
    if (toolMatch && request.tools?.some((t) => t.name === toolMatch[1])) {
      return {
        provider: 'mock',
        model: request.model,
        content: [
          {
            type: 'tool_call',
            id: `mock_call_${this.calls}`,
            name: toolMatch[1]!,
            input: toolMatch[2] ? (JSON.parse(toolMatch[2]) as Record<string, unknown>) : {},
          },
        ],
        stopReason: 'tool_use',
        usage,
      };
    }

    return {
      provider: 'mock',
      model: request.model,
      content: [{ type: 'text', text: sawToolResult ? 'mock: tool result received' : `mock: ${text}` }],
      stopReason: 'end',
      usage,
    };
  }
}
