import type { DesignDocument, ToothFrame } from '@dcad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { applyCommands } from '../design/reducer';
import { useDesignStore } from '../design/store';
import { estimateFrameAt } from './frameTool';
import { useToolStore } from './toolStore';

const frameAt = (x: number, source: ToothFrame['source'] = 'auto'): ToothFrame => ({ origin: [x, 0, 0], occlusal: [0, 0, 1], mesial: [-1, 0, 0], buccal: [0, 1, 0], source });

// The worker: a click frames the tooth at the click; the layout puts each pontic halfway between its abutments.
vi.mock('../workers/geometryClient', () => ({
  analysis: {
    estimateFrame: async ({ seed }: { seed: [number, number, number] }) => ({ ...frameAt(seed[0]), warnings: [] }),
    bridgeFrames: async ({ units }: { units: Array<{ fdi: number; frame?: ToothFrame }> }) => {
      const x = (fdi: number) => units.find((u) => u.fdi === fdi)?.frame?.origin[0] ?? 0;
      return { abutments: [], pontics: [{ fdi: 36, frame: frameAt((x(35) + x(37)) / 2), warnings: [] }] };
    },
  },
}));
vi.mock('../state/sceneController', () => ({ sceneController: { geometryFor: (role: string) => (role === 'lower' ? { sha256: 'lower', geometry: null } : null) } }));

const bridge = (pontic: ToothFrame): DesignDocument =>
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
    { type: 'setFrame', fdi: 35, frame: frameAt(0) },
    { type: 'setFrame', fdi: 37, frame: frameAt(20) },
    { type: 'setFrame', fdi: 36, frame: pontic },
  ]);

const originOf = (fdi: number) => useDesignStore.getState().doc.teeth.find((t) => t.fdi === fdi)?.frame?.origin[0];

describe('pontics follow a redone abutment frame', () => {
  beforeEach(() => useToolStore.getState().set({ message: null, busy: null }));

  it('re-lays out an automatically placed pontic in the same undo step, and leaves one the user placed', async () => {
    useDesignStore.getState().load(bridge(frameAt(10)), 35);
    await estimateFrameAt([4, 0, 0]);
    expect(originOf(35)).toBe(4);
    expect(originOf(36)).toBe(12);
    expect(useDesignStore.getState().past).toHaveLength(1);

    useDesignStore.getState().load(bridge(frameAt(9, 'manual')), 35);
    await estimateFrameAt([4, 0, 0]);
    expect(originOf(36)).toBe(9);
  });
});
