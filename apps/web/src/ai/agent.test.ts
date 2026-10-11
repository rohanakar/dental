import type { Crown, LlmContentPart, LlmRequest, LlmResponse, ToothFrame } from '@dcad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { applyCommands } from '../design/reducer';
import { useDesignStore } from '../design/store';

const METRICS = {
  fdi: 36,
  crownProposed: true,
  minOcclusalClearanceMm: 0.05,
  mesialContactMm: 0.02,
  distalContactMm: 0.03,
  minThicknessMm: 0.6,
  marginLengthMm: 27.9,
  printable: true,
  conflicts: [],
};
vi.mock('../tools/crownTool', () => ({ crownTool: { settled: vi.fn(async () => null), evaluate: vi.fn(async () => null) } }));
vi.mock('./metrics', () => ({ designMetrics: vi.fn(async () => METRICS) }));
vi.mock('../api/client', () => ({ llm: vi.fn() }));

const { acceptAgentChanges, revertAgentChanges, runAgent, trimHistory } = await import('./agent');

const frame: ToothFrame = { origin: [0, 0, 0], occlusal: [0, 0, 1], mesial: [0, 1, 0], buccal: [1, 0, 0], source: 'auto' };
const crown: Crown = { kind: 'template', templateId: 'synthetic.lower-molar@1', pose: { position: [10, 5, 1], quaternion: [0, 0, 0, 1], scale: [-1, 1, 1] } };

/** Scripted LLM: returns the given responses in order (then a plain "done"). */
function scripted(...turns: LlmContentPart[][]) {
  const calls: LlmRequest[] = [];
  let i = 0;
  const llm = async (request: LlmRequest): Promise<LlmResponse> => {
    calls.push(structuredClone(request));
    const content = turns[i++] ?? [{ type: 'text', text: 'done' }];
    return { provider: 'test', model: 'm', content, stopReason: content.some((p) => p.type === 'tool_call') ? 'tool_use' : 'end', usage: { inputTokens: 10, outputTokens: 5 } };
  };
  return { llm, calls };
}
const call = (name: string, input: Record<string, unknown>, id = 'c1'): LlmContentPart => ({ type: 'tool_call', id, name, input });
const pose = () => (useDesignStore.getState().doc.teeth[0]!.crown as Extract<Crown, { kind: 'template' }>).pose;

beforeEach(() => {
  const doc = applyCommands(newDocument(), [
    { type: 'setFrame', fdi: 36, frame },
    { type: 'setCrown', fdi: 36, crown },
  ]);
  useDesignStore.getState().load(doc, 0);
});

describe('agent tool loop', () => {
  it('turns a tool call into a command inside one transaction and returns metrics', async () => {
    const { llm, calls } = scripted([call('move_crown', { fdi: 36, direction: 'mesial', mm: 0.2 })], [{ type: 'text', text: 'Moved the crown 0.2 mm mesial.' }]);
    const run = await runAgent({ instruction: 'move it a bit mesial', llm });
    expect(pose().position).toEqual([10, 5.2, 1]);
    expect(run.transactionOpen).toBe(true);
    expect(useDesignStore.getState().transaction).toMatchObject({ author: 'agent', label: 'Assistant: move it a bit mesial' });
    expect(run.finalText).toBe('Moved the crown 0.2 mm mesial.');
    expect(run.actions).toEqual([expect.objectContaining({ tool: 'move_crown', ok: true })]);
    // The second request carries the tool result with fresh metrics.
    const result = calls[1]!.messages.at(-1)!.content[0]!;
    expect(result).toMatchObject({ type: 'tool_result', toolCallId: 'c1' });
    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ applied: 'move_crown mesial 0.2', metrics: { minOcclusalClearanceMm: 0.05 } });
    expect(calls[0]!.tools!.map((t) => t.name)).toContain('move_crown');
    expect(run.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    const past = useDesignStore.getState().past.length;
    acceptAgentChanges();
    expect(useDesignStore.getState().past.length).toBe(past + 1);
    expect(useDesignStore.getState().lastAuthor).toBe('agent');
  });

  it('reports invalid input to the model as an error and changes nothing', async () => {
    const { llm, calls } = scripted([call('move_crown', { fdi: 36, direction: 'up', mm: 0.2 })]);
    const run = await runAgent({ instruction: 'move up', llm });
    const result = calls[1]!.messages.at(-1)!.content[0] as { isError?: boolean; content: string };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Invalid input/);
    expect(pose().position).toEqual([10, 5, 1]);
    expect(run.transactionOpen).toBe(false);
    expect(run.actions[0]).toMatchObject({ ok: false });
  });

  it('stops after maxTurns', async () => {
    const forever = async (): Promise<LlmResponse> => ({
      provider: 'test',
      model: 'm',
      content: [call('get_design_metrics', { fdi: 36 }, `c${Math.random()}`)],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const run = await runAgent({ instruction: 'loop', llm: forever, maxTurns: 3 });
    expect(run.finalText).toMatch(/Stopped after 3 turns/);
    expect(run.transcript.filter((m) => m.role === 'assistant')).toHaveLength(3);
  });

  it('answers questions without opening a transaction', async () => {
    const { llm, calls } = scripted([call('get_case_summary', {}), call('get_design_metrics', { fdi: 36 }, 'c2')], [{ type: 'text', text: 'Clearance is 0.05 mm.' }]);
    const run = await runAgent({ instruction: 'how much occlusal clearance?', llm });
    expect(run.transactionOpen).toBe(false);
    expect(useDesignStore.getState().transaction).toBeNull();
    const summary = JSON.parse((calls[1]!.messages.at(-1)!.content[0] as { content: string }).content);
    expect(summary).toMatchObject({ activeTooth: 36, teeth: [{ fdi: 36, material: 'zirconia' }] });
    expect(run.finalText).toBe('Clearance is 0.05 mm.');
    expect(run.actions).toEqual([]);
  });

  it('reverts the whole run', async () => {
    const { llm } = scripted([call('move_crown', { fdi: 36, direction: 'occlusal', mm: 0.5 }), call('scale_crown', { fdi: 36, axis: 'occlusal', pct: -5 }, 'c2')]);
    await runAgent({ instruction: 'shorter', llm });
    expect(pose().position[2]).toBeCloseTo(1.5);
    revertAgentChanges();
    expect(pose()).toEqual(crown.kind === 'template' ? crown.pose : undefined);
    expect(useDesignStore.getState().transaction).toBeNull();
  });

  it('refuses capture_view and enforces tool schemas for queries', async () => {
    const { llm, calls } = scripted([call('capture_view', { fdi: 36, view: 'occlusal' }), call('get_design_metrics', { fdi: 99 }, 'c2')]);
    await runAgent({ instruction: 'show me', llm });
    const results = calls[1]!.messages.at(-1)!.content as Array<{ isError?: boolean; content: string }>;
    expect(results[0]).toMatchObject({ isError: true, content: expect.stringMatching(/not supported/) });
    expect(results[1]).toMatchObject({ isError: true });
  });
});

describe('trimHistory', () => {
  it('never starts on a tool result', () => {
    const t = (role: 'user' | 'assistant', part: LlmContentPart) => ({ role, content: [part] });
    const msgs = [
      t('user', { type: 'text', text: 'a' }),
      t('assistant', { type: 'tool_call', id: '1', name: 'x', input: {} }),
      t('user', { type: 'tool_result', toolCallId: '1', content: 'r' }),
      t('assistant', { type: 'text', text: 'b' }),
      t('user', { type: 'text', text: 'c' }),
      t('assistant', { type: 'text', text: 'd' }),
    ];
    expect(trimHistory(msgs, 4).map((m) => m.content[0])).toEqual([{ type: 'text', text: 'c' }, { type: 'text', text: 'd' }]);
    expect(trimHistory(msgs, 10)).toBe(msgs);
  });
});
