import { type LlmRequest, type LlmResponse, validateBridges } from '@dcad/shared';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ llm: vi.fn() }));

const { extractRxWithLlm, parseRxClassical } = await import('./rx');

const crown = (fdi: number, material: string, shade?: string, restoration = 'anatomic-crown') => ({ fdi, restoration, material, ...(shade ? { shade } : {}) });
const pontic = (fdi: number, material: string, shade?: string, restoration = 'pontic') => ({ fdi, restoration, material, ...(shade ? { shade } : {}) });

/** Synthetic prescriptions (no patient data) with the exact setups the rule-based reader must produce. */
const CASES: Array<{ name: string; text: string; setup: object }> = [
  {
    name: 'labelled ref, FDI, zirconia, shade',
    text: 'Ref: LAB-2026-0142\nFull contour zirconia crown on tooth 36, shade A2.',
    setup: { patientRef: 'LAB-2026-0142', teeth: [crown(36, 'zirconia', 'A2')], notes: '', connections: [] },
  },
  {
    name: 'Palmer shorthand, words for quadrants, an anterior tooth and bare shade',
    text: 'UR7 and UL2 crowns, zirconia, B1\nLower left 6 and lower right 5 as well',
    setup: {
      patientRef: '',
      teeth: [crown(17, 'zirconia', 'B1'), crown(22, 'zirconia', 'B1'), crown(36, 'zirconia', 'B1'), crown(45, 'zirconia', 'B1')],
      notes: '',
      connections: [],
    },
  },
  {
    // A span's ends are abutments and the teeth between pontics; named pontics join the run of teeth around them.
    name: 'a posterior bridge and an anterior bridge with two cantilevers across the midline',
    text: 'Bridge 35-37, zirconia\n11, 21 crowns, 12 and 22 cantilever pontics',
    setup: {
      patientRef: '',
      teeth: [crown(35, 'zirconia'), pontic(36, 'zirconia'), crown(37, 'zirconia'), crown(11, 'zirconia'), crown(21, 'zirconia'), pontic(12, 'zirconia'), pontic(22, 'zirconia')],
      notes: '',
      connections: [
        [11, 12],
        [11, 21],
        [21, 22],
        [35, 36],
        [36, 37],
      ],
    },
  },
  {
    // A line about implants makes its retainers implant crowns; a metal-ceramic line makes its units reduced
    // (cut back for porcelain), and metal-ceramic without a named alloy reads as CoCr.
    name: 'an implant bridge and a metal-ceramic (cut-back) bridge',
    text: 'Ref: LAB-7\nImplant bridge 35-37, screw-retained on Ti-bases\nPFM bridge 44-46, cut back for layering\nShade A3',
    setup: {
      patientRef: 'LAB-7',
      teeth: [
        crown(35, 'cocr', 'A3', 'implant-crown'),
        pontic(36, 'cocr', 'A3'),
        crown(37, 'cocr', 'A3', 'implant-crown'),
        crown(44, 'cocr', 'A3', 'reduced-crown'),
        pontic(45, 'cocr', 'A3', 'reduced-pontic'),
        crown(46, 'cocr', 'A3', 'reduced-crown'),
      ],
      notes: '',
      // In arch order: the lower arch runs 48→41, then 31→38.
      connections: [
        [45, 46],
        [44, 45],
        [35, 36],
        [36, 37],
      ],
    },
  },
];

describe('rule-based Rx reader', () => {
  it.each(CASES)('$name', ({ text, setup }) => {
    const result = parseRxClassical(text);
    expect(result.setup).toEqual(setup);
    expect(result.valid).toBe(true);
    expect(validateBridges(result.setup).errors).toEqual([]);
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
          // 37 is not in the case: its connection is dropped, not refused.
          input: { patientRef: 'LAB-1', notes: '', teeth: [crown(36, 'lithium-disilicate', 'A2'), crown(21, 'zirconia')], connections: [[36, 37]] },
        },
      ]),
    );
    const out = await extractRxWithLlm('Ref: LAB-1\nTooth 36 crown, zirconia, shade A2', llm);
    expect(out.source).toBe('llm');
    expect(out.setup.teeth.map((t) => t.fdi)).toEqual([36, 21]);
    expect(out.setup.connections).toEqual([]);
    expect(out.issues.errors).toEqual([]);
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
