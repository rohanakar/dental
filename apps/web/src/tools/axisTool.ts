import type { InsertionAxis } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import type { Viewer } from '../engine/Viewer';
import { analysis } from '../workers/geometryClient';
import type { AxisAnalysis } from '../workers/analysisTypes';
import { isStale } from '../workers/latestWins';
import { errorText, fromMarginPoints, toothContext } from './context';
import { useToolStore, type V3 } from './toolStore';

/** Undercut depths at or above this show as fully red. */
export const UNDERCUT_RANGE_MM: [number, number] = [0, 0.5];

const normalize = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

/**
 * Lean `axis` toward `toward` by `deg` degrees. Works in the plane spanned by
 * the two vectors, so it does not depend on the frame's handedness (which
 * differs per FDI quadrant).
 */
export function tiltToward(axis: readonly number[], toward: readonly number[], deg: number): V3 {
  const a = normalize(axis);
  const d = toward[0]! * a[0] + toward[1]! * a[1] + toward[2]! * a[2];
  const perp = normalize([toward[0]! - d * a[0], toward[1]! - d * a[1], toward[2]! - d * a[2]]);
  const r = (deg * Math.PI) / 180;
  return normalize([0, 1, 2].map((i) => a[i]! * Math.cos(r) + perp[i]! * Math.sin(r)));
}

/**
 * Insertion axis tool: least-undercut search, axis from the view direction,
 * small tilts in clinical directions, and the undercut colour map for the
 * current axis.
 */
class AxisTool {
  private viewer: Viewer | null = null;
  /** Inputs of the map currently shown, so it is recomputed only when they change. */
  private shown: { axis: InsertionAxis; margin: unknown } | null = null;

  attach(viewer: Viewer | null): void {
    this.viewer = viewer;
    this.shown = null;
  }

  /** Entering the axis step: propose an axis if there is none yet. */
  enter(): void {
    const tooth = toothContext()?.tooth;
    if (tooth?.margin && tooth.frame && !tooth.axis) void this.search();
  }

  /**
   * Called on every store change while the axis step is active: refresh the
   * map when the axis or margin changed. Never proposes an axis by itself, so
   * undoing setAxis does not immediately re-create one (and clear redo).
   */
  sync(): void {
    const ctx = toothContext();
    const { axis, margin } = ctx?.tooth ?? {};
    if (!ctx || !margin || !ctx.tooth.frame) return;
    if (!axis) {
      if (this.shown) this.hide();
      return;
    }
    if (this.shown?.axis === axis && this.shown.margin === margin) return;
    void this.evaluate(axis);
  }

  /** Least-undercut search in a cone around the occlusal direction. */
  async search(): Promise<void> {
    const ctx = toothContext();
    const { margin, frame } = ctx?.tooth ?? {};
    if (!ctx || !margin || !frame) return;
    const result = await this.run('Searching for the least-undercut axis…', () =>
      analysis.axis({ jawSha: ctx.jaw.sha256, margin: fromMarginPoints(margin.points), occlusal: [...frame.occlusal] }),
    );
    if (!result) return;
    const axis: InsertionAxis = { direction: result.direction, source: 'auto' };
    useDesignStore.getState().dispatch({ type: 'setAxis', fdi: ctx.fdi, axis });
    const tooth = useDesignStore.getState().doc.teeth.find((t) => t.fdi === ctx.fdi);
    if (tooth?.axis) this.show(result, tooth.axis, tooth.margin);
  }

  /** Insertion along the current view: the camera looks down the axis onto the prep. */
  fromView(): void {
    const v = this.viewer?.viewDirection();
    if (v) this.set([-v.x, -v.y, -v.z]);
  }

  /** Tilt the axis toward a clinical direction by `deg` degrees. */
  tilt(toward: 'mesial' | 'distal' | 'buccal' | 'lingual', deg = 1): void {
    const { axis, frame } = toothContext()?.tooth ?? {};
    if (!axis || !frame) return;
    const target = toward === 'mesial' || toward === 'distal' ? frame.mesial : frame.buccal;
    const sign = toward === 'mesial' || toward === 'buccal' ? 1 : -1;
    this.set(tiltToward(axis.direction, target.map((x) => x * sign), deg));
  }

  /** Clear the colour map (leaving the step). */
  hide(): void {
    const ctx = toothContext();
    if (ctx) this.viewer?.setObjectScalars(ctx.jaw.role, null);
    this.viewer?.overlays.remove('axis:margin-undercut');
    this.shown = null;
    useToolStore.getState().set({ legend: null, axisReport: null });
  }

  private set(direction: V3): void {
    const ctx = toothContext();
    if (!ctx) return;
    useDesignStore.getState().dispatch({ type: 'setAxis', fdi: ctx.fdi, axis: { direction: normalize(direction), source: 'manual' } });
  }

  private async evaluate(axis: InsertionAxis): Promise<void> {
    const ctx = toothContext();
    const { margin, frame } = ctx?.tooth ?? {};
    if (!ctx || !margin || !frame) return;
    this.shown = { axis, margin };
    const result = await this.run('Computing the undercut map…', () =>
      analysis.axis({
        jawSha: ctx.jaw.sha256,
        margin: fromMarginPoints(margin.points),
        occlusal: [...frame.occlusal],
        direction: [...axis.direction],
      }),
    );
    if (result) this.show(result, axis, margin);
  }

  private async run(busy: string, task: () => Promise<AxisAnalysis>): Promise<AxisAnalysis | null> {
    const tools = useToolStore.getState();
    tools.set({ busy, message: null });
    try {
      return await task();
    } catch (e) {
      if (!isStale(e)) tools.set({ message: { kind: 'error', text: `Axis analysis failed: ${errorText(e)}` } });
      return null;
    } finally {
      useToolStore.getState().set({ busy: null });
    }
  }

  private show(result: AxisAnalysis, axis: InsertionAxis, margin: unknown): void {
    const ctx = toothContext();
    if (!ctx || useDesignStore.getState().activeStep !== 'axis') return;
    this.shown = { axis, margin };
    this.viewer?.setObjectScalars(ctx.jaw.role, result.depths, { map: 'undercut', range: UNDERCUT_RANGE_MM });
    const points = ctx.tooth.margin?.points ?? [];
    const flagged = points.filter((_, i) => result.marginFlags[i]).map((m) => m.p);
    if (flagged.length > 0) this.viewer?.overlays.setMarkers('axis:margin-undercut', flagged, { color: '#d64545', sizePx: 7 });
    else this.viewer?.overlays.remove('axis:margin-undercut');
    useToolStore.getState().set({
      legend: {
        title: 'Undercut (blockout depth)',
        map: 'undercut',
        range: UNDERCUT_RANGE_MM,
        unit: 'mm',
        lowLabel: 'visible',
        highLabel: 'undercut',
      },
      axisReport: {
        undercutAreaMm2: result.undercutAreaMm2,
        angleFromOcclusalDeg: result.angleFromOcclusalDeg,
        maxDepthMm: result.maxDepthMm,
        marginUndercutCount: result.marginUndercutCount,
        marginPointCount: points.length,
        prepClosed: result.prepClosed,
      },
    });
  }
}

export const axisTool = new AxisTool();
