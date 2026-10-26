import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { createBridge } from './server.ts';

// A stand-in for `claude`: records its argv, cwd and stdin, then prints the next canned result line.
const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
let stdin = '';
process.stdin.setEncoding('utf8').on('data', (d) => (stdin += d)).on('end', () => {
  const n = readdirSync(join(dir, 'calls')).length;
  writeFileSync(join(dir, 'calls', n + '.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin }));
  const a = JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8'))[n];
  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  console.log(JSON.stringify({ type: 'result', subtype: a.is_error ? 'error_during_execution' : 'success', is_error: !!a.is_error,
    result: a.result ?? '', structured_output: a.structured_output, total_cost_usd: 0.01, duration_ms: 5 }));
});
`;

describe('claude bridge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-bridge-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('turns a Messages request into one claude -p call and its answer into a tool_use, retrying an invalid answer once', async () => {
    const bin = join(dir, 'fake-claude.mjs');
    writeFileSync(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    mkdirSync(join(dir, 'calls'));
    mkdirSync(join(dir, 'cwd'));
    writeFileSync(
      join(dir, 'answers.json'),
      JSON.stringify([
        { structured_output: { kind: 'tool_use', name: 'add_anchor', input: { fdi: 36, side: 'upward' } } }, // invalid side
        { structured_output: { kind: 'tool_use', name: 'add_anchor', input: { fdi: 36, side: 'distal' } } },
        { is_error: true, result: 'Not logged in' },
      ]),
    );
    const server = createBridge({ claudeBin: bin, concurrency: 1, timeoutMs: 10_000, cwd: join(dir, 'cwd'), log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new Anthropic({ apiKey: 'bridge', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const tools: Anthropic.Tool[] = [
      {
        name: 'add_anchor',
        description: 'Add a margin anchor on one side of the tooth.',
        input_schema: {
          type: 'object',
          properties: { fdi: { type: 'integer' }, side: { type: 'string', enum: ['mesial', 'distal', 'buccal', 'lingual'] } },
          required: ['fdi', 'side'],
        },
      },
    ];

    try {
      const { data: message, response } = await client.messages
        .create({
          model: 'claude-opus-5-5',
          max_tokens: 1024,
          system: 'You fix crown margins.',
          tools,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'The margin of 36 fails its checks.' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
              ],
            },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_prev', name: 'add_anchor', input: { fdi: 36, side: 'buccal' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: 'gate: fail, sharpest bend 71 deg distal' }] },
          ],
        })
        .withResponse();

      // Response: Anthropic's shape, parsed by the SDK.
      expect(message).toMatchObject({
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'add_anchor', input: { fdi: 36, side: 'distal' } }],
      });
      expect(message.content[0]).toHaveProperty('id', expect.stringMatching(/^toolu_bridge_/));
      expect(Number(response.headers.get('x-bridge-cost-usd'))).toBeCloseTo(0.02); // two attempts

      // Prompt: one claude -p run in the empty cwd, with the system prompt, the tools, the transcript and the image.
      const calls = readdirSync(join(dir, 'calls'))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(dir, 'calls', f), 'utf8')) as { argv: string[]; cwd: string; stdin: string });
      expect(calls).toHaveLength(2);
      const [first, second] = calls as [(typeof calls)[0], (typeof calls)[0]];
      expect(realpathSync(first.cwd)).toBe(realpathSync(join(dir, 'cwd')));
      expect(first.argv).toEqual(expect.arrayContaining(['-p', '--model=claude-opus-5-5', '--tools', '', '--setting-sources']));
      expect(first.argv.find((a) => a.startsWith('--system-prompt='))).toContain('You fix crown margins.');
      expect(JSON.parse(first.argv.find((a) => a.startsWith('--json-schema='))!.slice('--json-schema='.length))).toMatchObject({
        properties: { kind: { enum: ['tool_use', 'text'] }, name: { enum: ['add_anchor'] } },
      });
      const user = JSON.parse(first.stdin) as { type: string; message: { role: string; content: Array<Record<string, any>> } };
      expect(user.type).toBe('user');
      const text = user.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      expect(text).toContain('<tool name="add_anchor">');
      expect(text).toContain('"enum":["mesial","distal","buccal","lingual"]');
      expect(text).toContain('The margin of 36 fails its checks.');
      expect(text).toContain('<tool_call id="toolu_prev" name="add_anchor">{"fdi":36,"side":"buccal"}</tool_call>');
      expect(text).toContain('gate: fail, sharpest bend 71 deg distal');
      expect(user.message.content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
      // The retry tells the model why its first answer was rejected.
      expect(second.stdin).toContain('input.side');

      // A CLI error is a 502 that the SDK does not retry.
      const failed = await client.messages
        .create({ model: 'claude-opus-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })
        .catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(Anthropic.APIError);
      expect((failed as InstanceType<typeof Anthropic.APIError>).status).toBe(502);
      expect(readdirSync(join(dir, 'calls'))).toHaveLength(3);
    } finally {
      server.close();
    }
  });
});
