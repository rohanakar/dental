import type { ScanRole, StepId } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import type { Viewer } from '../engine/Viewer';
import { useSceneStore } from '../state/sceneStore';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { fromMarginPoints, toothContext } from './context';
import { useToolStore } from './toolStore';

/** Steps in which the crown is adjusted. */
const FOCUS_STEPS: readonly StepId[] = ['proposal', 'adapt'];
/** Greying of the surroundings. */
const SURROUNDINGS_DESATURATE = 0.6;

const v3 = (p: readonly number[]): [number, number, number] => [p[0]!, p[1]!, p[2]!];

/**
 * Focus view while the crown is adjusted: the prepared tooth (the prep
 * region inside the margin) keeps its normal look; the rest of the prep jaw
 * and the antagonist are drawn semi-transparent and greyed by the
 * "Surroundings" factor. The scans' own opacities (object panel) still
 * apply on top. Leaving the steps or unticking "Focus on the prep" restores
 * the normal look. (A gum band around the margin was tried and dropped: with
 * the gum see-through, its sulcus walls showed as fragments under the crown.)
 */
class FocusTool {
  private viewer: Viewer | null = null;
  private key: unknown[] = [];
  private focused: ScanRole[] = [];
  /** Focus faces of the last margin (the worker caches them too). */
  private cache: { sha: string; margin: unknown; occlusal: unknown; faces: Uint32Array } | null = null;

  constructor() {
    useToolStore.subscribe((s, prev) => {
      if (s.focusPrep !== prev.focusPrep || s.surroundings !== prev.surroundings) this.sync();
    });
  }

  attach(viewer: Viewer | null): void {
    this.clear();
    this.viewer = viewer;
    this.key = [];
  }

  /** Called on design and scene changes. */
  sync(): void {
    const v = this.viewer;
    if (!v) return;
    const { activeStep } = useDesignStore.getState();
    const { focusPrep, surroundings } = useToolStore.getState();
    const ctx = toothContext();
    const tooth = ctx?.tooth;
    const on = Boolean(focusPrep && FOCUS_STEPS.includes(activeStep) && tooth?.crown && tooth.margin && tooth.frame);
    // Scene objects are in the key so a re-added scan gets the look again.
    const key = on && ctx ? [ctx.jaw.sha256, ctx.antagonist?.role, tooth!.margin, tooth!.frame, surroundings, useSceneStore.getState().objects] : [];
    if (key.length === this.key.length && key.every((x, i) => x === this.key[i])) return;
    this.key = key;
    if (!on || !ctx || !tooth?.margin || !tooth.frame) {
      this.clear();
      return;
    }
    const look = (faces: Uint32Array | null) => ({ faces, contextOpacity: surroundings, desaturate: SURROUNDINGS_DESATURATE });
    const apply = (faces: Uint32Array) => {
      if (this.key !== key || this.viewer !== v) return; // superseded
      const roles: ScanRole[] = [ctx.jaw.role, ...(ctx.antagonist ? [ctx.antagonist.role] : [])];
      for (const role of this.focused) if (!roles.includes(role)) v.setObjectFocus(role, null);
      v.setObjectFocus(ctx.jaw.role, look(faces));
      if (ctx.antagonist) v.setObjectFocus(ctx.antagonist.role, look(null));
      this.focused = roles;
    };
    const { margin, frame } = tooth;
    const c = this.cache;
    if (c && c.sha === ctx.jaw.sha256 && c.margin === margin && c.occlusal === frame.occlusal) {
      apply(c.faces);
      return;
    }
    analysis
      .focusFaces({ jawSha: ctx.jaw.sha256, margin: fromMarginPoints(margin.points), occlusal: v3(frame.occlusal) })
      .then((faces) => {
        this.cache = { sha: ctx.jaw.sha256, margin, occlusal: frame.occlusal, faces };
        apply(faces);
      })
      .catch((e: unknown) => {
        // Without a closed prep region there is no crown to focus on; keep the normal look.
        if (!isStale(e) && this.key === key) this.clear();
      });
  }

  private clear(): void {
    for (const role of this.focused) this.viewer?.setObjectFocus(role, null);
    this.focused = [];
  }
}

export const focusTool = new FocusTool();
