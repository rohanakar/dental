import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { agentToolDefs, commandFromToolCall, type LlmMessage } from '@dcad/shared';
import { fromAnthropicMessage, toAnthropicRequest } from '../src/adapters/llm/anthropic';
import { fromOpenAiCompletion, toOpenAiRequest } from '../src/adapters/llm/openai';
import { toOpenAiStrictSchema } from '../src/adapters/llm/openai-strict';
import { MemoryRateLimiter } from '../src/adapters/rate-limit/memory';
import { loadConfig, resolveDatabaseUrl } from '../src/config';

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

describe('LLM adapters', () => {
  it('translates messages, tools and responses for the Anthropic Messages API', () => {
    const req = toAnthropicRequest({
      model: 'claude-sonnet-5',
      system: 'You are a dental CAD assistant.',
      messages: conversation,
      tools: agentToolDefs(),
      maxTokens: 1024,
    });
    expect(req.system).toBe('You are a dental CAD assistant.');
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
    expect(fromAnthropicMessage(message)).toEqual({
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

  it('translates messages and completions for OpenAI, dropping strict-mode nulls', () => {
    const req = toOpenAiRequest({ model: 'gpt-5', system: 'sys', messages: conversation, tools: agentToolDefs(), maxTokens: 512 });
    expect(req.messages[0]).toEqual({ role: 'system', content: 'sys' });
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
    // The browser validates the call with the original zod schema.
    expect(commandFromToolCall('move_crown', (res.content[0] as { input: Record<string, unknown> }).input)).toEqual({
      type: 'moveCrown',
      fdi: 36,
      direction: 'occlusal',
      mm: 0.1,
    });
  });

  it('normalises every agent tool schema for OpenAI strict mode', () => {
    type S = Record<string, unknown>;
    const assertStrict = (schema: S, path: string): void => {
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
    };
    for (const tool of agentToolDefs()) assertStrict(toOpenAiStrictSchema(tool.inputSchema), tool.name);
  });
});

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', AUTH_SECRET: 'x'.repeat(32) };

  it('picks the LLM provider from the available keys: anthropic, then openai, then mock', () => {
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }).llm.routes.agent.provider).toBe('anthropic');
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'o' }).llm.routes.agent.provider).toBe('openai');
    expect(loadConfig({ ...base }).llm.routes.agent.provider).toBe('mock');
  });

  it('expands ${VAR} in DATABASE_URL with URL encoding, or builds it from POSTGRES_*', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://dcad:${POSTGRES_PASSWORD}@127.0.0.1:5432/dcad', POSTGRES_PASSWORD: 'p@ss:w/rd!' })).toBe(
      'postgres://dcad:p%40ss%3Aw%2Frd!@127.0.0.1:5432/dcad',
    );
    expect(() => resolveDatabaseUrl({ DATABASE_URL: 'postgres://dcad:${NOPE}@h/db' })).toThrow(/NOPE/);
    expect(resolveDatabaseUrl({ POSTGRES_PASSWORD: 'a#b' })).toBe('postgres://dcad:a%23b@127.0.0.1:5432/dcad');
  });
});

describe('MemoryRateLimiter', () => {
  it('allows `limit` requests per window', () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 60_000, () => now);
    expect(limiter.consume('u').allowed).toBe(true);
    expect(limiter.consume('u').allowed).toBe(true);
    expect(limiter.consume('u').allowed).toBe(false);
    expect(limiter.consume('other').allowed).toBe(true);
    now = 60_000;
    expect(limiter.consume('u').allowed).toBe(true);
  });
});
