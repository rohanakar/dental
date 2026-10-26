import { bridgeOf, type InsertionAxis, jawOf, type MarginLine, type ToothFrame, unitKind } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import type { Viewer } from '../engine/Viewer';
import { AXIS_DIVERGENCE_WARN_DEG } from '../geometry/axis';
import { sceneController } from '../state/sceneController';
import { analysis } from '../workers/geometryClient';
import type { AxisAnalysis, BridgeAxisResult } from '../workers/analysisTypes';
import { isStale } from '../workers/latestWins';
import { errorText, fromMarginPoints, toothContext, type ToothContext } from './context';
import { useToolStore, type AxisReport, type V3 } from './toolStore';
import { wingSeed } from './wing';

/** Undercut depths at or above this show as fully red. */
export const UNDERCUT_RANGE_MM: [number, number] = [0, 0.5];

const normalize = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const v3 = (p: readonly number[]): V3 => [p[0]!, p[1]!, p[2]!];
const angleDeg = (a: readonly number[], b: readonly number[]) => {
  const x = normalize(a);
  const y = normalize(b);
  return (Math.acos(Math.min(1, Math.max(-1, x[0] * y[0] + x[1] * y[1] + x[2] * y[2]))) * 180) / Math.PI;
};
const sameArray = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

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

type Abutment = { fdi: number; margin?: MarginLine; frame?: ToothFrame };
type ReadyAbutment = { fdi: number; margin: MarginLine; frame: ToothFrame };
const isReady = (a: Abutment): a is ReadyAbutment => Boolean(a.margin && a.frame);

/** The active tooth as an abutment of a bridge: every abutment of that bridge shares its insertion axis. */
interface BridgeAxisContext {
  ctx: ToothContext;
  abutments: Abutment[];
}

function bridgeAxisContext(): BridgeAxisContext | null {
  const ctx = toothContext();
  if (!ctx) return null;
  const { doc } = useDesignStore.getState();
  const bridge = bridgeOf(doc, ctx.fdi);
  if (!bridge || unitKind(doc.setup, ctx.fdi) !== 'abutment') return null;
  const abutments = bridge.teeth
    .filter((f) => unitKind(doc.setup, f) === 'abutment')
    .map((fdi) => {
      const t = doc.teeth.find((x) => x.fdi === fdi);
      return { fdi, margin: t?.margin, frame: t?.frame };
    });
  return { ctx, abutments };
}

/** What the common-axis analysis depends on: every abutment's margin and frame. */
const inputsKey = (abutments: readonly Abutment[]): unknown[] => abutments.flatMap((a) => [a.margin, a.frame]);

/**
 * Insertion axis tool: least-undercut search, axis from the view direction,
 * small tilts in clinical directions, and the undercut colour map for the
 * current axis. For an abutment of a bridge the axis is common to every
 * abutment: the search runs over all their preps (analysis.bridgeAxis), the
 * map and the margin check cover each of them, and setAxis on the active
 * tooth sets the others too (reducer).
 */
class AxisTool {
  private viewer: Viewer | null = null;
  /** Inputs of the map currently shown, so it is recomputed only when they change. */
  private shown: { axis: InsertionAxis; margin: unknown } | null = null;
  /** The last common-axis search (each abutment's own axis, the divergence), for the margins and frames it ran on. */
  private bridgeSearch: { key: unknown[]; result: BridgeAxisResult } | null = null;
  private generation = 0;

  attach(viewer: Viewer | null): void {
    this.viewer = viewer;
    this.shown = null;
  }

  /** Entering the axis step: propose an axis if there is none yet. */
  enter(): void {
    const bridge = bridgeAxisContext();
    if (bridge) {
      const tooth = bridge.ctx.tooth;
      if (!tooth.axis && bridge.abutments.every(isReady)) void this.search();
      return;
    }
    const tooth = toothContext()?.tooth;
    if (tooth?.margin && tooth.frame && !tooth.axis) void this.search();
  }

  /**
   * Called on every store change while the axis step is active: refresh the
   * map when the axis or margin changed. Never proposes an axis by itself, so
   * undoing setAxis does not immediately re-create one (and clear redo).
   */
  sync(): void {
    const bridge = bridgeAxisContext();
    if (bridge) {
      const axis = bridge.ctx.tooth.axis;
      if (!axis) {
        if (this.shown) this.hide();
        return;
      }
      const key = inputsKey(bridge.abutments);
      if (this.shown?.axis === axis && Array.isArray(this.shown.margin) && sameArray(this.shown.margin, key)) return;
      void this.evaluateBridge(bridge, axis);
      return;
    }
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

  /** Least-undercut search in a cone around the occlusal direction (for a bridge: over every abutment). */
  async search(): Promise<void> {
    const bridge = bridgeAxisContext();
    if (bridge) return this.searchBridge(bridge);
    const ctx = toothContext();
    const { margin, frame } = ctx?.tooth ?? {};
    if (!ctx || !margin || !frame) return;
    const result = await this.run('Searching for the least-undercut axis…', () =>
      analysis.axis({ jawSha: ctx.jaw.sha256, margin: fromMarginPoints(margin.points), occlusal: [...frame.occlusal], ...wingSeed(useDesignStore.getState().doc.setup, ctx.fdi, frame) }),
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

  /** The undercut analysis of the current axis without showing it, e.g. for the finalize checks. Null without an axis. */
  async measure(): Promise<AxisReport | null> {
    return this.measureTooth(useDesignStore.getState().activeFdi);
  }

  /** The undercut analysis of one tooth at its stored axis (a bridge abutment: the common axis on its own prep). */
  async measureTooth(fdi: number): Promise<AxisReport | null> {
    const tooth = useDesignStore.getState().doc.teeth.find((t) => t.fdi === fdi);
    const jaw = sceneController.geometryFor(jawOf(fdi));
    const { margin, frame, axis } = tooth ?? {};
    if (!jaw || !margin || !frame || !axis) return null;
    try {
      // Unlatched: an independent measurement must not cancel (or be cancelled by) the axis step's own map.
      const result = await analysis.axisUnlatched({
        jawSha: jaw.sha256,
        margin: fromMarginPoints(margin.points),
        occlusal: [...frame.occlusal],
        direction: [...axis.direction],
        ...wingSeed(useDesignStore.getState().doc.setup, fdi, frame),
      });
      return axisReport(result, margin.points.length);
    } catch {
      return null;
    }
  }

  /** Clear the colour map (leaving the step). */
  hide(): void {
    this.generation++;
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
        ...wingSeed(useDesignStore.getState().doc.setup, ctx.fdi, frame),
      }),
    );
    if (result) this.show(result, axis, margin);
  }

  private async run<T>(busy: string, task: () => Promise<T>): Promise<T | null> {
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
    useToolStore.getState().set({ legend: UNDERCUT_LEGEND, axisReport: axisReport(result, points.length) });
  }

  // ---- bridges: one common axis -------------------------------------------------------------

  private bridgeRequest(ctx: ToothContext, abutments: readonly ReadyAbutment[]) {
    return {
      jawSha: ctx.jaw.sha256,
      abutments: abutments.map((a) => ({
        fdi: a.fdi,
        margin: fromMarginPoints(a.margin.points),
        occlusal: v3(a.frame.occlusal),
        ...wingSeed(useDesignStore.getState().doc.setup, a.fdi, a.frame),
      })),
    };
  }

  private async searchBridge(bridge: BridgeAxisContext): Promise<void> {
    const missing = bridge.abutments.filter((a) => !isReady(a)).map((a) => a.fdi);
    if (missing.length) {
      useToolStore.getState().set({
        message: { kind: 'warning', text: `Set the frame and margin on ${missing.join(', ')} first: the common axis is searched over every abutment.` },
      });
      return;
    }
    const abutments = bridge.abutments.filter(isReady);
    const result = await this.run('Searching for the common insertion axis…', () => analysis.bridgeAxis(this.bridgeRequest(bridge.ctx, abutments)));
    if (!result) return;
    this.bridgeSearch = { key: inputsKey(abutments), result };
    if (!result.prepClosed) {
      // A margin that does not close lets its prep region leak onto the neighbours: the search ran on the wrong faces.
      const open = result.abutments.filter((a) => !a.prepClosed).map((a) => a.fdi);
      useToolStore.getState().set({
        message: { kind: 'error', text: `The margin of ${open.join(', ')} is not closed on the surface, so no common axis was set. Fix the margin first.` },
      });
      return;
    }
    // The reducer sets the same axis on every abutment of the bridge; the map follows from sync().
    useDesignStore.getState().dispatch({ type: 'setAxis', fdi: bridge.ctx.fdi, axis: { direction: result.direction, source: 'auto' } });
  }

  /** Each abutment's own best axis and the divergence: from the last search, or searched now for these preps. */
  private async searchFor(ctx: ToothContext, abutments: readonly ReadyAbutment[]): Promise<BridgeAxisResult | null> {
    const key = inputsKey(abutments);
    if (this.bridgeSearch && sameArray(this.bridgeSearch.key, key)) return this.bridgeSearch.result;
    try {
      const result = await analysis.bridgeAxisUnlatched(this.bridgeRequest(ctx, abutments));
      this.bridgeSearch = { key, result };
      return result;
    } catch {
      return null;
    }
  }

  /** The common axis on every abutment: one merged undercut map, the margin points in undercut, and a row per abutment. */
  private async evaluateBridge(bridge: BridgeAxisContext, axis: InsertionAxis): Promise<void> {
    const { ctx } = bridge;
    const abutments = bridge.abutments.filter(isReady);
    this.shown = { axis, margin: inputsKey(bridge.abutments) };
    if (abutments.length === 0) return;
    const generation = ++this.generation;
    const tools = useToolStore.getState();
    tools.set({ busy: 'Computing the undercut map…', message: null });
    try {
      // Unlatched and in parallel (one call per prep); superseded runs are dropped by the generation.
      const [analyses, found] = await Promise.all([
        Promise.all(
          abutments.map((a) =>
            analysis.axisUnlatched({
              jawSha: ctx.jaw.sha256,
              margin: fromMarginPoints(a.margin.points),
              occlusal: v3(a.frame.occlusal),
              direction: v3(axis.direction),
              ...wingSeed(useDesignStore.getState().doc.setup, a.fdi, a.frame),
            }),
          ),
        ),
        this.searchFor(ctx, abutments),
      ]);
      if (generation !== this.generation) return;
      this.showBridge(abutments, analyses, found, axis);
    } catch (e) {
      if (generation === this.generation) useToolStore.getState().set({ message: { kind: 'error', text: `Axis analysis failed: ${errorText(e)}` } });
    } finally {
      if (generation === this.generation) useToolStore.getState().set({ busy: null });
    }
  }

  private showBridge(abutments: readonly ReadyAbutment[], analyses: AxisAnalysis[], found: BridgeAxisResult | null, axis: InsertionAxis): void {
    const ctx = toothContext();
    if (!ctx || useDesignStore.getState().activeStep !== 'axis') return;
    // One map over every prep: the deepest undercut per vertex (NaN outside all preps).
    const n = analyses[0]!.depths.length;
    const depths = new Float32Array(n).fill(Number.NaN);
    for (const a of analyses) {
      for (let i = 0; i < n; i++) {
        const d = a.depths[i]!;
        if (!Number.isNaN(d) && !(depths[i]! >= d)) depths[i] = d;
      }
    }
    this.viewer?.setObjectScalars(ctx.jaw.role, depths, { map: 'undercut', range: UNDERCUT_RANGE_MM });
    const flagged = abutments.flatMap((a, k) => a.margin.points.filter((_, i) => analyses[k]!.marginFlags[i]).map((m) => m.p));
    if (flagged.length > 0) this.viewer?.overlays.setMarkers('axis:margin-undercut', flagged, { color: '#d64545', sizePx: 7 });
    else this.viewer?.overlays.remove('axis:margin-undercut');

    const rows = abutments.map((a, k) => {
      const r = analyses[k]!;
      const searched = found?.abutments.find((x) => x.fdi === a.fdi);
      const own = searched?.individualAxis;
      return {
        fdi: a.fdi,
        marginUndercutCount: r.marginUndercutCount,
        marginPointCount: a.margin.points.length,
        blockoutAreaMm2: r.undercutAreaMm2,
        maxDepthMm: r.maxDepthMm,
        prepClosed: r.prepClosed && (searched?.prepClosed ?? true),
        angleToOwnDeg: own ? angleDeg(own, axis.direction) : null,
      };
    });
    const divergenceDeg = found ? found.divergenceDeg : null;
    const report: AxisReport = {
      undercutAreaMm2: rows.reduce((s, r) => s + r.blockoutAreaMm2, 0),
      // From the mean occlusal direction of the abutments (the centre of the search cone).
      angleFromOcclusalDeg: angleDeg(axis.direction, found?.center ?? ctx.tooth.frame?.occlusal ?? axis.direction),
      maxDepthMm: Math.max(0, ...rows.map((r) => r.maxDepthMm)),
      marginUndercutCount: rows.reduce((s, r) => s + r.marginUndercutCount, 0),
      marginPointCount: rows.reduce((s, r) => s + r.marginPointCount, 0),
      prepClosed: rows.every((r) => r.prepClosed),
      bridge: {
        abutments: rows,
        divergenceDeg,
        warnings:
          divergenceDeg !== null && divergenceDeg > AXIS_DIVERGENCE_WARN_DEG
            ? [`The abutments' own axes diverge by ${divergenceDeg.toFixed(1)}° (over ${AXIS_DIVERGENCE_WARN_DEG}°): the common axis needs large blockouts.`]
            : [],
      },
    };
    useToolStore.getState().set({ legend: UNDERCUT_LEGEND, axisReport: report });
  }
}

const UNDERCUT_LEGEND = {
  title: 'Undercut (blockout depth)',
  map: 'undercut' as const,
  range: UNDERCUT_RANGE_MM,
  unit: 'mm',
  lowLabel: 'visible',
  highLabel: 'undercut',
};

const axisReport = (result: AxisAnalysis, marginPointCount: number): AxisReport => ({
  undercutAreaMm2: result.undercutAreaMm2,
  angleFromOcclusalDeg: result.angleFromOcclusalDeg,
  maxDepthMm: result.maxDepthMm,
  marginUndercutCount: result.marginUndercutCount,
  marginPointCount,
  prepClosed: result.prepClosed,
});

export const axisTool = new AxisTool();
