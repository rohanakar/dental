import type { LlmRequest, LlmResponse } from '@dcad/shared';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ llm: vi.fn() }));

const { extractRxWithLlm, parseRxClassical } = await import('./rx');

const crown = (fdi: number, material: string, shade?: string) => ({ fdi, restoration: 'anatomic-crown', material, ...(shade ? { shade } : {}) });

/** Synthetic prescriptions (no patient data) with the exact setups the rule-based reader must produce. */
const CASES: Array<{ name: string; text: string; setup: object }> = [
  {
    name: 'labelled ref, FDI, zirconia, shade',
    text: 'Ref: LAB-2026-0142\nFull contour zirconia crown on tooth 36, shade A2.',
    setup: { patientRef: 'LAB-2026-0142', teeth: [crown(36, 'zirconia', 'A2')], notes: '', connections: [] },
  },
  {
    name: 'Palmer shorthand, an anterior tooth and bare shade',
    text: 'UR7 and UL2 crowns, zirconia, B1',
    setup: { patientRef: '', teeth: [crown(17, 'zirconia', 'B1'), crown(22, 'zirconia', 'B1')], notes: '', connections: [] },
  },
  {
    name: 'words for quadrants',
    text: 'Lower left 6 and lower right 5: monolithic zirconia, shade A3',
    setup: { patientRef: '', teeth: [crown(36, 'zirconia', 'A3'), crown(45, 'zirconia', 'A3')], notes: '', connections: [] },
  },
];

describe('rule-based Rx reader', () => {
  it.each(CASES)('$name', ({ text, setup }) => {
    const result = parseRxClassical(text);
    expect(result.setup).toEqual(setup);
    expect(result.valid).toBe(true);
  });
});

const response = (content: LlmResponse['content'], provider = 'anthropic'): LlmResponse => ({
  provider,
  model: 'm',
  content,
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1 },
});

describe('LLM Rx extraction', () => {
  it('uses the tool call, keeps anterior teeth and compares with the rule-based reader', async () => {
    const llm = vi.fn(async (_r: LlmRequest) =>
      response([
        {
          type: 'tool_call',
          id: 'c1',
          name: 'submit_case_setup',
          input: { patientRef: 'LAB-1', notes: '', teeth: [crown(36, 'lithium-disilicate', 'A2'), crown(21, 'zirconia')] },
        },
      ]),
    );
    const out = await extractRxWithLlm('Ref: LAB-1\nTooth 36 crown, zirconia, shade A2', llm);
    expect(out.source).toBe('llm');
    expect(out.setup.teeth.map((t) => t.fdi)).toEqual([36, 21]);
    expect(out.differences).toEqual([
      { field: 'teeth', llm: '21, 36', classical: '36' },
      { field: '36 material', llm: 'lithium-disilicate', classical: 'zirconia' },
    ]);
  });

  it('falls back to the rule-based reader for the mock provider, errors and bad output', async () => {
    const text = 'Tooth 46 crown, zirconia, shade A3';
    const mock = await extractRxWithLlm(text, async () => response([{ type: 'text', text: 'mock' }], 'mock'));
    expect(mock.source).toBe('classical');
    expect(mock.setup.teeth[0]).toMatchObject({ fdi: 46, material: 'zirconia', shade: 'A3' });
    const failing = await extractRxWithLlm(text, async () => {
      throw new Error('offline');
    });
    expect(failing.source).toBe('classical');
    const invalid = await extractRxWithLlm(text, async () => response([{ type: 'tool_call', id: 'x', name: 'submit_case_setup', input: { teeth: [] } }]));
    expect(invalid.source).toBe('classical');
  });
});
