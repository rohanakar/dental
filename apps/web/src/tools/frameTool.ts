import { bridgeOf, type Command, type DesignDocument, jawOf, type ToothFrame, unitKind } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import type { InteractionHandler } from '../engine/Viewer';
import { runAutoDesign } from '../ai/orchestrator';
import { sceneController } from '../state/sceneController';
import type { BridgeFramesRequest, BridgeFramesResult } from '../workers/analysisTypes';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { frameView } from './bridgeTool';
import { errorText, fromMarginPoints, toothContext } from './context';
import { missesDemoPrep } from './demoPrep';
import { PREP_MARGIN } from './marginView';
import { useToolStore, type V3 } from './toolStore';

const neg = (v: readonly number[]): V3 => [-v[0]!, -v[1]!, -v[2]!];

/** Estimate the tooth frame from a click on the prep (auto source). */
export async function estimateFrameAt(seed: V3): Promise<void> {
  const ctx = toothContext();
  const tools = useToolStore.getState();
  if (!ctx) return;
  tools.set({ busy: 'Estimating the tooth frame…', message: null });
  try {
    const restoration = useDesignStore.getState().doc.setup.teeth.find((t) => t.fdi === ctx.fdi)?.restoration;
    const est = await analysis.estimateFrame({
      jawSha: ctx.jaw.sha256,
      antagonistSha: ctx.antagonist?.sha256,
      seed,
      fdi: ctx.fdi,
      // On a crown prep a front tooth's frame follows the prep's own axis; a scan body, a wing's tooth or a cavity
      // keeps the jaw-level frame.
      prep: restoration ? PREP_MARGIN.includes(restoration) : true,
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

// ---- bridges: abutment frames aligned to the arch, pontic frames laid out on it -----------------------

/** Changes of an abutment's mesial direction below this are not worth an edit. */
export const ALIGN_MIN_DEG = 0.5;

/**
 * The Frame-step request for the bridge that contains `fdi`: every abutment with its frame (and its margin once
 * drawn: its extremes are the unit's edges), every pontic with an optional centre click. Null when `fdi` is not in a
 * bridge, its jaw is not loaded, or an abutment has no frame yet.
 */
export function bridgeFramesRequest(doc: DesignDocument, fdi: number, centre?: { fdi: number; point: V3 }): BridgeFramesRequest | null {
  const bridge = bridgeOf(doc, fdi);
  const jaw = bridge && sceneController.geometryFor(jawOf(bridge.teeth[0]!));
  if (!bridge || !jaw) return null;
  const units: BridgeFramesRequest['units'] = [];
  for (const f of bridge.teeth) {
    const tooth = doc.teeth.find((t) => t.fdi === f);
    const kind = unitKind(doc.setup, f);
    if (kind === 'pontic') {
      units.push({ fdi: f, kind, ...(centre?.fdi === f ? { centre: centre.point } : {}) });
      continue;
    }
    if (!tooth?.frame) return null;
    units.push({ fdi: f, kind, frame: frameView(tooth.frame), ...(tooth.margin ? { margin: fromMarginPoints(tooth.margin.points) } : {}) });
  }
  return { jawSha: jaw.sha256, units };
}

/** "Align to arch": each abutment's mesial-distal line from the arch curve (bridgeFrames), as one undo entry. */
export function alignAbutments(result: BridgeFramesResult): void {
  const cmds: Command[] = result.abutments
    .filter((a) => a.changeDeg >= ALIGN_MIN_DEG)
    .map((a) => ({ type: 'setFrame', fdi: a.fdi, frame: { ...a.frame, source: 'auto' } }));
  if (cmds.length) useDesignStore.getState().dispatch(cmds);
}

/** "Place pontics": every pontic's frame from its layout on the arch curve, as one undo entry. */
export function placePontics(result: BridgeFramesResult): void {
  const cmds: Command[] = result.pontics.map((p) => ({ type: 'setFrame', fdi: p.fdi, frame: { ...p.frame, source: 'auto' } }));
  if (cmds.length) useDesignStore.getState().dispatch(cmds);
}

/** A click on the ridge while a pontic is active: lay that pontic out around the clicked centre. */
export async function placePonticAt(point: V3): Promise<void> {
  const { doc, activeFdi } = useDesignStore.getState();
  const tools = useToolStore.getState();
  const request = bridgeFramesRequest(doc, activeFdi, { fdi: activeFdi, point });
  if (!request) {
    tools.set({ message: { kind: 'warning', text: 'Set the frames of the abutments first: pontics are placed on the arch between them.' } });
    return;
  }
  tools.set({ busy: `Placing pontic ${activeFdi}…`, message: null });
  try {
    const result = await analysis.bridgeFrames(request);
    const layout = result.pontics.find((p) => p.fdi === activeFdi);
    if (!layout) return;
    useDesignStore.getState().dispatch({ type: 'setFrame', fdi: activeFdi, frame: { ...layout.frame, source: 'manual' } });
    if (layout.warnings.length) tools.set({ message: { kind: 'warning', text: layout.warnings.join(' ') } });
  } catch (e) {
    if (!isStale(e)) tools.set({ message: { kind: 'error', text: `Could not place the pontic: ${errorText(e)}` } });
  } finally {
    useToolStore.getState().set({ busy: null });
  }
}

export function frameInteraction(jawRole: string): InteractionHandler {
  return {
    targets: () => [jawRole],
    cursor: 'crosshair',
    onClick(hit) {
      if (!hit) return;
      const point: V3 = [hit.point.x, hit.point.y, hit.point.z];
      const { framePick, set, autoArmed } = useToolStore.getState();
      const { doc, activeFdi } = useDesignStore.getState();
      if (framePick === 'seed' && unitKind(doc.setup, activeFdi) === 'pontic' && bridgeOf(doc, activeFdi)) {
        // A pontic has no prep to click: the click sets its centre on the ridge.
        void placePonticAt(point);
        return;
      }
      if (framePick === 'seed' && missesDemoPrep(point)) {
        set({ message: { kind: 'warning', text: `That is not tooth ${activeFdi}. Click the prepared tooth inside the blue ring.` } });
        return;
      }
      if (framePick === 'seed' && autoArmed) {
        set({ autoArmed: false, message: null });
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
