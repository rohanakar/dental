import type { LlmRequest, LlmResponse } from '@dcad/shared';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ llm: vi.fn() }));

const { caseSetupToolSchema, compareRx, extractRxWithLlm, parseRxClassical } = await import('./rx');

const crown = (fdi: number, material: string, shade?: string) => ({ fdi, restoration: 'anatomic-crown', material, ...(shade ? { shade } : {}) });

/** Synthetic prescriptions (no patient data) with the exact setups the rule-based reader must produce. */
const CASES: Array<{ name: string; text: string; setup: object; notes: RegExp[] }> = [
  {
    name: 'labelled ref, FDI, zirconia, shade',
    text: 'Ref: LAB-2026-0142\nFull contour zirconia crown on tooth 36, shade A2.',
    setup: { patientRef: 'LAB-2026-0142', teeth: [crown(36, 'zirconia', 'A2')], notes: '' },
    notes: [],
  },
  {
    name: 'two teeth with #, e.max, half shade, instruction kept as notes',
    text: 'Case: C-77\nCrowns #46 and #47 in e.max, shade A3.5\nLight occlusal contact please.',
    setup: { patientRef: 'C-77', teeth: [crown(46, 'lithium-disilicate', 'A3.5'), crown(47, 'lithium-disilicate', 'A3.5')], notes: 'Light occlusal contact please.' },
    notes: [],
  },
  {
    name: 'Palmer shorthand and bare shade',
    text: 'UR7 crown, zirconia, B1',
    setup: { patientRef: '', teeth: [crown(17, 'zirconia', 'B1')], notes: '' },
    notes: [],
  },
  {
    name: 'words for quadrants',
    text: 'Lower left 6 and lower right 5: monolithic zirconia, shade A3',
    setup: { patientRef: '', teeth: [crown(36, 'zirconia', 'A3'), crown(45, 'zirconia', 'A3')], notes: '' },
    notes: [],
  },
  {
    name: 'anterior tooth rejected',
    text: 'Teeth 11 and 14, zirconia, shade A1',
    setup: { patientRef: '', teeth: [crown(14, 'zirconia', 'A1')], notes: '' },
    notes: [/Tooth 11 is an anterior/],
  },
  {
    name: 'missing material defaults to zirconia (flagged)',
    text: 'Tooth 26 crown, shade C2',
    setup: { patientRef: '', teeth: [crown(26, 'zirconia', 'C2')], notes: '' },
    notes: [/defaulted to zirconia/],
  },
  {
    name: 'provisional PMMA, no shade',
    text: 'Provisional crown on 35 (PMMA) until the final is ready',
    setup: { patientRef: '', teeth: [crown(35, 'pmma')], notes: '' },
    notes: [],
  },
  {
    name: 'dates and times are not teeth',
    text: 'Date: 2026-10-11 10:30\nRx for tooth 37, lithium disilicate, shade D3',
    setup: { patientRef: '', teeth: [crown(37, 'lithium-disilicate', 'D3')], notes: 'Date: 2026-10-11 10:30' },
    notes: [],
  },
  {
    name: 'several materials: first one wins (flagged)',
    text: 'Crowns on 16 zirconia and 15 e.max, shade A2',
    setup: { patientRef: '', teeth: [crown(16, 'zirconia', 'A2'), crown(15, 'zirconia', 'A2')], notes: '' },
    notes: [/Several materials/],
  },
  {
    name: 'words + LiSi + trailing ref',
    text: 'Upper left 4 premolar crown in LiSi2, shade B2, ref: P-001',
    setup: { patientRef: 'P-001', teeth: [crown(24, 'lithium-disilicate', 'B2')], notes: '' },
    notes: [],
  },
];

describe('rule-based Rx reader on 10 synthetic prescriptions', () => {
  it.each(CASES)('$name', ({ text, setup, notes }) => {
    const result = parseRxClassical(text);
    expect(result.setup).toEqual(setup);
    expect(result.valid).toBe(true);
    expect(result.notes).toHaveLength(notes.length);
    notes.forEach((re, i) => expect(result.notes[i]).toMatch(re));
  });

  it('reports when no supported tooth is found', () => {
    const result = parseRxClassical('Please make something nice, shade A2');
    expect(result.valid).toBe(false);
    expect(result.setup.teeth).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/No supported tooth/);
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
  it('offers a submit_case_setup tool with the CaseSetup JSON schema', () => {
    const schema = caseSetupToolSchema();
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('$schema');
    expect(Object.keys(schema.properties as object)).toEqual(expect.arrayContaining(['patientRef', 'teeth', 'notes']));
  });

  it('uses the tool call, drops anterior teeth and compares with the rule-based reader', async () => {
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
    expect(llm.mock.calls[0]![0]).toMatchObject({ purpose: 'rx-intake', tools: [{ name: 'submit_case_setup' }] });
    expect(out.source).toBe('llm');
    expect(out.setup.teeth.map((t) => t.fdi)).toEqual([36]);
    expect(out.notes.join(' ')).toMatch(/Tooth 21 is an anterior/);
    expect(out.differences).toEqual([{ field: '36 material', llm: 'lithium-disilicate', classical: 'zirconia' }]);
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
    expect(failing.notes[0]).toMatch(/unavailable \(offline\)/);
    const invalid = await extractRxWithLlm(text, async () => response([{ type: 'tool_call', id: 'x', name: 'submit_case_setup', input: { teeth: [] } }]));
    expect(invalid.source).toBe('classical');
  });

  it('compareRx lists field differences only', () => {
    const a = { patientRef: 'A', notes: '', teeth: [{ fdi: 36, restoration: 'anatomic-crown' as const, material: 'zirconia' as const }] };
    expect(compareRx(a, a)).toEqual([]);
    expect(compareRx(a, { ...a, patientRef: '' })).toEqual([{ field: 'patientRef', llm: 'A', classical: '—' }]);
  });
});
