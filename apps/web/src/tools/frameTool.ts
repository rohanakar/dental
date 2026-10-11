import type { ToothFrame } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import type { InteractionHandler } from '../engine/Viewer';
import { runAutoDesign } from '../ai/orchestrator';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { errorText, toothContext } from './context';
import { useToolStore, type V3 } from './toolStore';

const neg = (v: readonly number[]): V3 => [-v[0]!, -v[1]!, -v[2]!];

/** Estimate the tooth frame from a click on the prep (auto source). */
export async function estimateFrameAt(seed: V3): Promise<void> {
  const ctx = toothContext();
  const tools = useToolStore.getState();
  if (!ctx) return;
  tools.set({ busy: 'Estimating the tooth frame…', message: null });
  try {
    const est = await analysis.estimateFrame({
      jawSha: ctx.jaw.sha256,
      antagonistSha: ctx.antagonist?.sha256,
      seed,
      fdi: ctx.fdi,
    });
    const { warnings, ...frame } = est;
    useDesignStore.getState().dispatch({ type: 'setFrame', fdi: ctx.fdi, frame: { ...frame, source: 'auto' } });
    tools.set({ frameWarnings: warnings });
  } catch (e) {
    if (!isStale(e)) tools.set({ message: { kind: 'error', text: `Could not estimate the frame: ${errorText(e)}` } });
  } finally {
    tools.set({ busy: null });
  }
}

function updateFrame(update: (f: ToothFrame) => ToothFrame): void {
  const ctx = toothContext();
  const frame = ctx?.tooth.frame;
  if (!ctx || !frame) return;
  useDesignStore.getState().dispatch({ type: 'setFrame', fdi: ctx.fdi, frame: { ...update(frame), source: 'manual' } });
}

/**
 * Mesial and buccal were derived together through the quadrant's
 * handedness, so a wrong mesial sign means buccal is wrong too: flip both
 * (occlusal stays) and swap the contacts.
 */
export function flipMesialDistal(): void {
  updateFrame((f) => ({
    ...f,
    mesial: neg(f.mesial),
    buccal: neg(f.buccal),
    mesialContact: f.distalContact,
    distalContact: f.mesialContact,
  }));
}

export function clearContact(side: 'mesial' | 'distal'): void {
  updateFrame((f) => {
    const next = { ...f };
    delete next[side === 'mesial' ? 'mesialContact' : 'distalContact'];
    return next;
  });
}

export function frameInteraction(jawRole: string): InteractionHandler {
  return {
    targets: () => [jawRole],
    cursor: 'crosshair',
    onClick(hit) {
      if (!hit) return;
      const point: V3 = [hit.point.x, hit.point.y, hit.point.z];
      const { framePick, set, autoArmed } = useToolStore.getState();
      if (framePick === 'seed' && autoArmed) {
        set({ autoArmed: false });
        void runAutoDesign({ seed: point });
        return;
      }
      if (framePick === 'seed') {
        void estimateFrameAt(point);
        return;
      }
      updateFrame((f) => ({ ...f, [framePick]: point }));
      set({ framePick: 'seed' });
    },
  };
}
