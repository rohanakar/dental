import type { ClinicalDirection, Command } from '@dcad/shared';
import { create } from 'zustand';
import { crownCentre, normalize3, templateHeight, type V3 } from '../design/clinical';
import { useDesignStore } from '../design/store';
import type { Viewer } from '../engine/Viewer';
import { crownTool } from './crownTool';
import { userEdit } from './nudge';

/** Schema limit for one moveCrown command. */
const MAX_STEP_MM = 2;
/** Components smaller than this are dropped (sub-micron jitter from the drag). */
const MIN_COMPONENT_MM = 0.005;

interface GizmoState {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
}

/** Whether the translate gizmo is shown in the proposal step (toggle in the nudge pad). */
export const useGizmoStore = create<GizmoState>()((set) => ({
  enabled: true,
  setEnabled: (enabled) => set({ enabled }),
}));

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/**
 * World translation → moveCrown commands along the tooth frame. Components are
 * taken along mesial, buccal and occlusal (orthonormal), signs pick the
 * clinical direction, and moves longer than the 2 mm schema limit are split.
 */
export function movesForDelta(
  fdi: number,
  delta: readonly number[],
  frame: { mesial: readonly number[]; buccal: readonly number[]; occlusal: readonly number[] },
): Command[] {
  const axes: Array<[readonly number[], ClinicalDirection, ClinicalDirection]> = [
    [normalize3(frame.mesial), 'mesial', 'distal'],
    [normalize3(frame.buccal), 'buccal', 'lingual'],
    [normalize3(frame.occlusal), 'occlusal', 'cervical'],
  ];
  const cmds: Command[] = [];
  for (const [axis, plus, minus] of axes) {
    const c = dot(delta, axis);
    let remaining = Math.abs(c);
    if (remaining < MIN_COMPONENT_MM) continue;
    const direction = c > 0 ? plus : minus;
    while (remaining > 1e-9) {
      const mm = Math.min(MAX_STEP_MM, remaining);
      cmds.push({ type: 'moveCrown', fdi, direction, mm: Math.round(mm * 1e4) / 1e4 });
      remaining -= mm;
    }
  }
  return cmds;
}

/**
 * Connects the viewer's translate gizmo to the document: it sits on the
 * crown's cusps with the tooth frame's axes, a drag is previewed by
 * crownTool (deformed like the fit, margin pinned), and the release becomes
 * ONE batch of moveCrown commands (one undo entry). The preview stays on
 * screen until crownTool's recompute replaces it.
 */
class GizmoTool {
  private viewer: Viewer | null = null;
  private shown: unknown[] = [];
  /** Last step permission from sync(), reused when the toggle changes. */
  private lastEnabled = false;

  constructor() {
    useGizmoStore.subscribe(() => this.sync(this.lastEnabled));
    // Each new crown result moves the anchor onto the crown actually shown.
    crownTool.onResult(() => this.sync(this.lastEnabled));
  }

  attach(viewer: Viewer | null): void {
    this.viewer?.setGizmo(null);
    this.viewer = viewer;
    this.shown = [];
  }

  /** Called on store changes; `enabled` = the active step allows the gizmo (the proposal step). */
  sync(enabled: boolean): void {
    this.lastEnabled = enabled;
    const v = this.viewer;
    if (!v || v.isGizmoDragging()) return;
    const { doc, activeFdi } = useDesignStore.getState();
    const tooth = doc.teeth.find((t) => t.fdi === activeFdi);
    const frame = tooth?.frame;
    const crown = tooth?.crown;
    const on = enabled && useGizmoStore.getState().enabled && Boolean(frame) && crown?.kind === 'template';
    const key = on ? [frame, crown, activeFdi, crownTool.current()] : [];
    if (key.length === this.shown.length && key.every((x, i) => x === this.shown[i])) return;
    this.shown = key;
    if (!on || !frame || crown?.kind !== 'template') {
      v.setGizmo(null);
      return;
    }
    const fdi = tooth!.fdi;
    v.setGizmo({
      position: crownTool.gizmoAnchor() ?? crownCentre(crown.pose, templateHeight(fdi)),
      axes: { mesial: [...frame.mesial] as V3, buccal: [...frame.buccal] as V3, occlusal: [...frame.occlusal] as V3 },
      // The document move (below) takes over from the drag preview without a frame in between.
      onDrag: (delta) => crownTool.previewDrag(delta),
      onCommit: (delta) => {
        const cmds = movesForDelta(fdi, delta, frame);
        if (cmds.length > 0) userEdit(cmds);
      },
    });
  }
}

export const gizmoTool = new GizmoTool();
