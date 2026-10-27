import type { DesignDocument, MarginLine, ToothFrame } from '@dcad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { applyCommands } from '../design/reducer';
import { useDesignStore } from '../design/store';
import { autoMargins, findMargins, teethWithoutMargin } from './autoMargins';
import { useToolStore } from './toolStore';

const frame: ToothFrame = { origin: [0, 0, 0], occlusal: [0, 0, 1], mesial: [0, 1, 0], buccal: [1, 0, 0], source: 'auto' };
const margin: MarginLine = { anchors: [{ p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }], points: [{ p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }], source: 'auto' };

/** The margin proposer per tooth: 35 passes, 37 fails its gate, 36 (a pontic: no prep) throws, as the real one does. */
vi.mock('../ai/proposers', () => ({
  marginProposer: {
    id: 'classical.margin-ridge@1',
    step: 'margin',
    appliesTo: () => true,
    async run({ fdi }: { fdi: number }) {
      if (fdi === 36) throw new Error('No margin ridge found around the prep (check the tooth frame)');
      return {
        proposerId: 'classical.margin-ridge@1',
        output: { commands: [{ type: 'setMargin', fdi, margin }], artifact: null },
        qa: [{ id: 'margin.smooth', passed: fdi === 35, message: 'The margin doubles back at one point' }],
        rationale: 'stub',
      };
    },
  },
}));
vi.mock('../state/sceneController', () => ({ sceneController: { geometryFor: (role: string) => (role === 'lower' ? { sha256: 'lower', geometry: null } : null) } }));

const bridge = (): DesignDocument =>
  applyCommands(newDocument(), [
    {
      type: 'setCaseSetup',
      setup: {
        patientRef: '',
        notes: '',
        teeth: [35, 36, 37].map((fdi) => ({ fdi, restoration: fdi === 36 ? ('pontic' as const) : ('anatomic-crown' as const), material: 'zirconia' as const })),
        connections: [[35, 36], [36, 37]],
      },
    },
    ...[35, 36, 37].map((fdi) => ({ type: 'setFrame' as const, fdi, frame })),
  ]);

const marginOf = (fdi: number) => useDesignStore.getState().doc.teeth.find((t) => t.fdi === fdi)?.margin;

describe('margins ready for review', () => {
  beforeEach(() => {
    useDesignStore.getState().load(bridge(), 0);
    useToolStore.getState().set({ message: null, busy: null, autoFrames: true });
  });

  it('sets the passing margins as one undo step, names the rest, and does not put back an undone margin', async () => {
    // The pontic has no prep; a failure on one tooth does not stop the others.
    expect(teethWithoutMargin()).toEqual([35, 37]);
    await findMargins([36, 35, 37]);
    expect(useDesignStore.getState().past).toHaveLength(1);
    expect([35, 36, 37].map((f) => Boolean(marginOf(f)))).toEqual([true, false, false]);
    const { message } = useToolStore.getState();
    expect(message?.kind).toBe('warning');
    expect(message?.text).toMatch(/36: .*37: /);

    // Automatic: only on a step that needs a margin, once per tooth and frame.
    useDesignStore.getState().undo();
    useDesignStore.getState().setActiveStep('frame');
    autoMargins();
    await vi.waitFor(() => expect(useToolStore.getState().busy).toBeNull());
    expect(marginOf(35)).toBeUndefined();
    useDesignStore.getState().setActiveStep('margin');
    autoMargins();
    await vi.waitFor(() => expect(marginOf(35)).toBeDefined());
    useDesignStore.getState().undo();
    autoMargins();
    await vi.waitFor(() => expect(useToolStore.getState().busy).toBeNull());
    expect(marginOf(35)).toBeUndefined();
  });
});
