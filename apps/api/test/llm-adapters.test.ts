import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { agentToolDefs, commandFromToolCall, type LlmMessage } from '@dcad/shared';
import { fromAnthropicMessage, toAnthropicRequest } from '../src/adapters/llm/anthropic';
import { MockLlmProvider } from '../src/adapters/llm/mock';
import { fromOpenAiCompletion, toOpenAiRequest } from '../src/adapters/llm/openai';
import { toOpenAiStrictSchema } from '../src/adapters/llm/openai-strict';
import { MemoryRateLimiter } from '../src/adapters/rate-limit/memory';
import { loadConfig } from '../src/config';

const conversation: LlmMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Lower the crown on 36 by 0.2mm' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Moving it.' },
      { type: 'tool_call', id: 'call_1', name: 'move_crown', input: { fdi: 36, direction: 'cervical', mm: 0.2 } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: 'call_1', content: '{"minClearanceMm":0.05}' }],
  },
];

describe('Anthropic adapter translation', () => {
  it('maps provider-agnostic messages and tools to the Messages API', () => {
    const req = toAnthropicRequest({
      model: 'claude-sonnet-5',
      system: 'You are a dental CAD assistant.',
      messages: conversation,
      tools: agentToolDefs(),
      maxTokens: 1024,
    });
    expect(req.model).toBe('claude-sonnet-5');
    expect(req.system).toBe('You are a dental CAD assistant.');
    expect(req.max_tokens).toBe(1024);
    expect(req.messages[0]!.content).toEqual([
      { type: 'text', text: 'Lower the crown on 36 by 0.2mm' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    expect(req.messages[1]!.content).toContainEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'move_crown',
      input: { fdi: 36, direction: 'cervical', mm: 0.2 },
    });
    expect(req.messages[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: '{"minClearanceMm":0.05}' },
    ]);
    const move = req.tools!.find((t) => 'name' in t && t.name === 'move_crown') as Anthropic.Tool;
    expect(move.input_schema.type).toBe('object');
    expect(Object.keys(move.input_schema.properties ?? {})).toEqual(expect.arrayContaining(['fdi', 'direction', 'mm']));
  });

  it('maps responses back, including tool calls and stop reasons', () => {
    const message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [
        { type: 'text', text: 'Adjusting occlusion.', citations: null },
        { type: 'tool_use', id: 'tu_1', name: 'adapt_occlusion', input: { fdi: 36, clearanceMm: 0.05 } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 30 },
    } as unknown as Anthropic.Message;
    const res = fromAnthropicMessage(message);
    expect(res).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      content: [
        { type: 'text', text: 'Adjusting occlusion.' },
        { type: 'tool_call', id: 'tu_1', name: 'adapt_occlusion', input: { fdi: 36, clearanceMm: 0.05 } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 120, outputTokens: 30 },
    });
  });
});

describe('OpenAI adapter translation', () => {
  it('maps messages: system, user parts, assistant tool_calls, tool results', () => {
    const req = toOpenAiRequest({
      model: 'gpt-5',
      system: 'sys',
      messages: conversation,
      tools: agentToolDefs(),
      maxTokens: 512,
    });
    expect(req.max_completion_tokens).toBe(512);
    expect(req.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(req.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Lower the crown on 36 by 0.2mm' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    });
    expect(req.messages[2]).toEqual({
      role: 'assistant',
      content: 'Moving it.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'move_crown', arguments: JSON.stringify({ fdi: 36, direction: 'cervical', mm: 0.2 }) },
        },
      ],
    });
    expect(req.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"minClearanceMm":0.05}' });
    expect(req.tools).toHaveLength(agentToolDefs().length);
  });

  it('maps completions back and drops strict-mode nulls', () => {
    const completion = {
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'move_crown', arguments: '{"fdi":36,"direction":"occlusal","mm":0.1,"extra":null}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 },
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    const res = fromOpenAiCompletion(completion);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 9 });
    expect(res.content).toEqual([
      { type: 'tool_call', id: 'call_9', name: 'move_crown', input: { fdi: 36, direction: 'occlusal', mm: 0.1 } },
    ]);
    // The browser validates the call with the original zod schema.
    expect(commandFromToolCall('move_crown', (res.content[0] as { input: Record<string, unknown> }).input)).toEqual({
      type: 'moveCrown',
      fdi: 36,
      direction: 'occlusal',
      mm: 0.1,
    });
  });
});

describe('OpenAI strict-mode schema normalisation', () => {
  type S = Record<string, unknown>;
  function assertStrict(schema: S, path = '$'): void {
    const isObj = schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'));
    if (isObj) {
      expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
      const props = (schema.properties ?? {}) as Record<string, S>;
      expect([...(schema.required as string[])].sort(), `${path}.required`).toEqual(Object.keys(props).sort());
      for (const [k, v] of Object.entries(props)) assertStrict(v, `${path}.${k}`);
    }
    for (const key of Object.keys(schema)) {
      expect(['$schema', 'default', 'minLength', 'maxLength'], `${path} has unsupported ${key}`).not.toContain(key);
    }
    if (Array.isArray(schema.anyOf)) (schema.anyOf as S[]).forEach((s, i) => assertStrict(s, `${path}.anyOf[${i}]`));
    if (schema.items && typeof schema.items === 'object') assertStrict(schema.items as S, `${path}.items`);
  }

  it('normalises every agent tool schema', () => {
    for (const tool of agentToolDefs()) assertStrict(toOpenAiStrictSchema(tool.inputSchema), tool.name);
  });

  it('turns optional properties into required nullable ones', () => {
    const out = toOpenAiStrictSchema({
      type: 'object',
      properties: {
        a: { type: 'number', minimum: 0, default: 1 },
        b: { type: 'string', enum: ['x', 'y'] },
        c: { type: 'object', properties: { d: { type: 'string', maxLength: 3 } } },
      },
      required: ['a'],
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        a: { type: 'number', minimum: 0 },
        b: { type: ['string', 'null'], enum: ['x', 'y', null] },
        c: {
          type: ['object', 'null'],
          properties: { d: { type: ['string', 'null'] } },
          required: ['d'],
          additionalProperties: false,
        },
      },
      required: ['a', 'b', 'c'],
      additionalProperties: false,
    });
  });
});

describe('Mock LLM provider', () => {
  it('echoes text and emits tool calls on /tool', async () => {
    const mock = new MockLlmProvider();
    const echo = await mock.complete({ model: 'mock-1', maxTokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    expect(echo.content).toEqual([{ type: 'text', text: 'mock: hi' }]);
    const call = await mock.complete({
      model: 'mock-1',
      maxTokens: 10,
      tools: agentToolDefs(),
      messages: [{ role: 'user', content: [{ type: 'text', text: '/tool get_design_metrics {"fdi":36}' }] }],
    });
    expect(call.stopReason).toBe('tool_use');
    expect(call.content[0]).toMatchObject({ type: 'tool_call', name: 'get_design_metrics', input: { fdi: 36 } });
  });
});

describe('config: LLM provider selection', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', AUTH_SECRET: 'x'.repeat(32) };

  it('falls back to mock without keys', () => {
    const c = loadConfig({ ...base });
    expect(c.llm.routes.agent).toEqual({ provider: 'mock', model: 'mock-1' });
  });

  it('prefers anthropic, then openai, with provider-specific default models', () => {
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }).llm.routes.agent).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(loadConfig({ ...base, OPENAI_API_KEY: 'o' }).llm.routes.agent).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'o' }).llm.routes.agent.provider).toBe('openai');
  });

  it('honours an explicit provider and ignores a model from another provider', () => {
    const c = loadConfig({ ...base, ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', LLM_AGENT_PROVIDER: 'openai', LLM_AGENT_MODEL: 'claude-opus-5-5' });
    expect(c.llm.routes.agent).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(c.llm.warnings.join('\n')).toMatch(/does not look like a openai model/);
  });

  it('derives the base path from PUBLIC_URL', () => {
    expect(loadConfig({ ...base }).basePath).toBe('');
    expect(loadConfig({ ...base, PUBLIC_URL: 'https://dental.cognifuze.com/' }).publicUrl).toBe('https://dental.cognifuze.com');
    const sub = loadConfig({ ...base, PUBLIC_URL: 'https://example.com/dental/' });
    expect(sub.basePath).toBe('/dental');
    expect(sub.publicOrigin).toBe('https://example.com');
  });
});

describe('MemoryRateLimiter', () => {
  it('allows `limit` requests per window', () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 60_000, () => now);
    expect(limiter.consume('u').allowed).toBe(true);
    expect(limiter.consume('u').allowed).toBe(true);
    const blocked = limiter.consume('u');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);
    expect(limiter.consume('other').allowed).toBe(true);
    now = 60_000;
    expect(limiter.consume('u').allowed).toBe(true);
  });
});
