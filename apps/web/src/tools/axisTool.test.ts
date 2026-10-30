import type { DesignDocument, MarginLine, ToothFrame } from '@dcad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { applyCommands } from '../design/reducer';
import { useDesignStore } from '../design/store';
import { axisTool } from './axisTool';
import { useToolStore } from './toolStore';

const frame: ToothFrame = { origin: [0, 0, 0], occlusal: [0, 0, 1], mesial: [0, 1, 0], buccal: [1, 0, 0], source: 'auto' };
const margin = (x: number): MarginLine => ({ anchors: [{ p: [x, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }], points: [{ p: [x, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }], source: 'auto' });

vi.mock('../workers/geometryClient', () => ({
  analysis: {
    axis: async () => ({ direction: [0, 0, 1], angleFromOcclusalDeg: 0, undercutAreaMm2: 0, depths: new Float32Array(0), maxDepthMm: 0, marginFlags: new Uint8Array(3), marginUndercutCount: 0, prepClosed: true, ms: 0 }),
  },
}));
vi.mock('../state/sceneController', () => ({ sceneController: { geometryFor: (role: string) => (role === 'lower' ? { sha256: 'lower', geometry: null } : null) } }));

const crown = (): DesignDocument =>
  applyCommands(newDocument(), [
    {
      type: 'setCaseSetup',
      setup: { patientRef: '', notes: '', teeth: [{ fdi: 36, restoration: 'anatomic-crown' as const, material: 'zirconia' as const }], connections: [] },
    },
    { type: 'setFrame' as const, fdi: 36, frame },
  ]);

const axisOf = () => useDesignStore.getState().doc.teeth.find((t) => t.fdi === 36)?.axis;

describe('the insertion axis, ready for review', () => {
  beforeEach(() => {
    useDesignStore.getState().load(crown(), 0);
    useToolStore.getState().set({ message: null, busy: null });
  });

  it('is proposed once its margin is ready, not put back when undone, and proposed again for a new margin', async () => {
    // On the axis step before the margin is found: nothing yet.
    useDesignStore.getState().setActiveStep('axis');
    axisTool.enter();
    expect(axisOf()).toBeUndefined();
    // The margin arrives (found on entering the step): the axis follows.
    useDesignStore.getState().dispatch({ type: 'setMargin', fdi: 36, margin: margin(1) });
    axisTool.enter();
    await vi.waitFor(() => expect(axisOf()).toBeDefined());
    // Undone: not proposed again for the same margin.
    useDesignStore.getState().undo();
    axisTool.enter();
    await vi.waitFor(() => expect(useToolStore.getState().busy).toBeNull());
    expect(axisOf()).toBeUndefined();
    // A changed margin is new input.
    useDesignStore.getState().dispatch({ type: 'setMargin', fdi: 36, margin: margin(1.2) });
    axisTool.enter();
    await vi.waitFor(() => expect(axisOf()).toBeDefined());
  });
});
