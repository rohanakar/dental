import type { LlmContentPart, LlmRequest, LlmResponse } from '@dcad/shared';

/**
 * An LlmFn over the Anthropic Messages API, for the evaluation harness. Point it at the real API, or at the local
 * `claude -p` bridge (tools/claude-bridge) with ANTHROPIC_BASE_URL. Adds up the bridge's reported cost.
 */
export function anthropicLlm(opts: { baseUrl: string; apiKey: string; model: string }): ((request: LlmRequest) => Promise<LlmResponse>) & { costUsd: () => number; calls: () => number } {
  let cost = 0;
  let calls = 0;
  const toBlock = (p: LlmContentPart) => {
    switch (p.type) {
      case 'text':
        return { type: 'text', text: p.text };
      case 'image':
        return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.dataBase64 } };
      case 'tool_call':
        return { type: 'tool_use', id: p.id, name: p.name, input: p.input };
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, ...(p.isError ? { is_error: true } : {}) };
    }
  };
  const fn = async (request: LlmRequest): Promise<LlmResponse> => {
    const body = {
      model: opts.model,
      max_tokens: request.maxTokens,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content.map(toBlock) })),
      ...(request.tools?.length ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
    };
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    calls++;
    cost += Number(res.headers.get('x-bridge-cost-usd') ?? 0);
    const json = (await res.json()) as {
      error?: { message: string };
      model: string;
      stop_reason: string;
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    if (!res.ok) throw new Error(`LLM ${res.status}: ${json.error?.message ?? JSON.stringify(json)}`);
    const content: LlmContentPart[] = json.content.flatMap((b): LlmContentPart[] =>
      b.type === 'text' ? [{ type: 'text', text: b.text ?? '' }] : b.type === 'tool_use' ? [{ type: 'tool_call', id: b.id!, name: b.name!, input: b.input ?? {} }] : [],
    );
    return {
      provider: 'anthropic',
      model: json.model,
      content,
      stopReason: json.stop_reason === 'tool_use' ? 'tool_use' : json.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
      usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
    };
  };
  return Object.assign(fn, { costUsd: () => cost, calls: () => calls });
}
