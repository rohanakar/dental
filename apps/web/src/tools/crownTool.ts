import { bridgeOf, type StepId } from '@dcad/shared';
import { BufferAttribute, BufferGeometry } from 'three';
import { activeAdapt } from '../design/adaptation';
import { useDesignStore } from '../design/store';
import type { Viewer } from '../engine/Viewer';
import { constructionInfo, crownStl, downloadBytes } from '../io/exportCrown';
import { markExported } from '../state/exported';
import { useSessionStore } from '../state/session';
import type { CrownMapName, CrownRequest, CrownResult } from '../workers/analysisTypes';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { cutbackFor } from '../design/framework';
import { bridgeTool } from './bridgeTool';
import { frameworkTool } from './frameworkTool';
import { errorText, fromMarginPoints, toothContext, type ToothContext } from './context';
import { CROWN_MAPS, crownMapLegend } from './crownLegend';
import { implantCrownRequest } from './implantTool';
import { inlayKey, inlayRequestOf } from './inlay';
import { useToolStore, type LegendSpec } from './toolStore';

export const CROWN_OBJECT_ID = 'crown';
/** Steps in which the crown is shown. */
const SHOW_CROWN: readonly StepId[] = ['params', 'proposal', 'adapt', 'finalize'];
export const APP_VERSION = '0.3.0';

type V3 = [number, number, number];
const v3 = (p: readonly number[]): V3 => [p[0]!, p[1]!, p[2]!];
const ZERO: V3 = [0, 0, 0];
const sameArray = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Vertices with at least this move weight count as cusps (they follow a move fully) for the gizmo anchor. */
const CUSP_MOVE_WEIGHT = 0.95;

export { CROWN_MAPS } from './crownLegend';

/** The crown map's legend for the active tooth (contact-centred clearance, the material minimum on thickness). */
function legendFor(map: CrownMapName): LegendSpec {
  const tooth = toothContext()?.tooth;
  if (!tooth) return CROWN_MAPS[map];
  const adapt = tooth.crown?.kind === 'template' ? tooth.crown.adapt : undefined;
  return crownMapLegend(map, tooth.params, { occlusion: adapt?.occlusion?.clearanceMm, contact: adapt?.mesial?.targetMm ?? adapt?.distal?.targetMm });
}

/** The worker request for a tooth's crown (null until it has a frame, a margin and an axis; an implant crown's own). */
export function crownRequest(ctx: ToothContext, withPose: boolean, map: CrownMapName | 'none'): CrownRequest | null {
  if (ctx.tooth.implant) return implantCrownRequest(ctx, withPose, map);
  const { frame, margin, axis, params, crown } = ctx.tooth;
  if (!frame || !margin || !axis) return null;
  const inlay = inlayRequestOf(useDesignStore.getState().doc, ctx.fdi);
  return {
    jawSha: ctx.jaw.sha256,
    antagonistSha: ctx.antagonist?.sha256,
    fdi: ctx.fdi,
    frame: {
      origin: v3(frame.origin),
      occlusal: v3(frame.occlusal),
      mesial: v3(frame.mesial),
      buccal: v3(frame.buccal),
      mesialContact: frame.mesialContact && v3(frame.mesialContact),
      distalContact: frame.distalContact && v3(frame.distalContact),
    },
    margin: fromMarginPoints(margin.points),
    axis: v3(axis.direction),
    params,
    pose: withPose && crown?.kind === 'template' ? crown.pose : undefined,
    maps: map === 'none' ? undefined : [map],
    adapt: withPose ? activeAdapt(ctx.tooth) : undefined,
    // A reduced crown is cut back on top of its anatomy (frameworkTool shows it).
    cutback: cutbackFor(useDesignStore.getState().doc, ctx.fdi),
    // An inlay or onlay: snapped into the cavity from the pre-op scan or the library tooth.
    ...(inlay ? { inlay } : {}),
  };
}

/** Everything the derived crown depends on; a change of any entry recomputes it. */
function inputsOf(ctx: ToothContext | null): unknown[] {
  const t = ctx?.tooth;
  const cutback = ctx ? cutbackFor(useDesignStore.getState().doc, ctx.fdi) : undefined;
  const inlay = ctx ? inlayKey(useDesignStore.getState().doc, ctx.fdi) : '';
  return [ctx?.jaw.sha256, ctx?.antagonist?.sha256, t?.frame, t?.margin, t?.axis, t?.params, t?.crown, t?.steps.adapt, useToolStore.getState().crownMap, t?.implant, t?.screwChannel, cutback, inlay];
}

/**
 * The crown mesh is derived data: recomputed in the worker from (scans,
 * frame, margin, axis, params, crown pose) whenever any of them changes, so
 * undo/redo and parameter edits always show the matching crown.
 *
 * While the active tooth is a unit of a bridge, bridgeTool shows the whole
 * bridge instead, and the methods below that act on "the crown" act on the
 * active unit (bridgeTool.ts). Single crowns take the path below unchanged.
 */
class CrownTool {
  private viewer: Viewer | null = null;
  private inputs: unknown[] = [];
  private geometry: BufferGeometry | null = null;
  private last: CrownResult | null = null;
  /** The compute currently in flight (for settled()). */
  private inflight: Promise<CrownResult | null> | null = null;
  /** Translation previewed on top of the document while the gizmo is dragged (world mm). */
  private dragOffset: V3 = ZERO;
  /** The displayed positions differ from `last.positions` (a move preview is on screen). */
  private previewing = false;
  /** Centroid of the last result's cusps (move weight ≥ CUSP_MOVE_WEIGHT). */
  private cuspCentre: V3 | null = null;
  private readonly listeners = new Set<() => void>();

  attach(viewer: Viewer | null): void {
    this.viewer = viewer;
    this.inputs = [];
    if (viewer && this.geometry) this.show();
  }

  /** Called on every store change. */
  sync(step: StepId): void {
    if (bridgeTool.handles()) {
      this.clear(false);
      bridgeTool.sync(step);
      frameworkTool.sync(step);
      return;
    }
    bridgeTool.clear();
    const ctx = toothContext();
    const crown = ctx?.tooth.crown;
    const inputs = inputsOf(ctx);
    if (!ctx || !crown) {
      this.clear();
    } else if (inputs.some((x, i) => x !== this.inputs[i])) {
      this.inputs = inputs;
      void this.compute(ctx, true);
      // Until the recompute lands, show the move at once (see applyPreview).
      this.applyPreview();
    }
    this.applyVisibility(step);
    frameworkTool.sync(step);
  }

  /** Called after each newly displayed crown result. Returns an unsubscribe function. */
  onResult(listener: () => void): () => void {
    this.listeners.add(listener);
    const offBridge = bridgeTool.onResult(listener);
    return () => {
      this.listeners.delete(listener);
      offBridge();
    };
  }

  /**
   * Preview a gizmo drag: show the crown moved by `delta` (world mm) on top of
   * the document, deformed the way the fit deforms it (the margin stays put,
   * the cusps follow). null ends the drag preview.
   */
  previewDrag(delta: readonly number[] | null): void {
    if (bridgeTool.handles()) return bridgeTool.previewDrag(delta);
    this.dragOffset = delta ? v3(delta) : ZERO;
    this.applyPreview();
  }

  /**
   * Where the move gizmo sits: the centroid of the displayed crown's cusps,
   * plus any move not recomputed yet. Null before the first crown.
   */
  gizmoAnchor(): V3 | null {
    if (bridgeTool.handles()) return bridgeTool.gizmoAnchor();
    if (!this.cuspCentre) return null;
    const m = this.pendingMove();
    return [this.cuspCentre[0] + m[0], this.cuspCentre[1] + m[1], this.cuspCentre[2] + m[2]];
  }

  /** Propose a new template pose from the frame, contacts and antagonist (setCrown). */
  async propose(): Promise<void> {
    if (bridgeTool.handles()) {
      await bridgeTool.propose();
      return;
    }
    const ctx = toothContext();
    if (!ctx) return;
    const result = await this.compute(ctx, false);
    if (!result) return;
    useDesignStore.getState().dispatch({
      type: 'setCrown',
      fdi: ctx.fdi,
      crown: { kind: 'template', templateId: result.templateId, pose: result.pose },
    });
    // The mesh on screen already matches the new document state.
    this.inputs = inputsOf(toothContext());
  }

  /** Choose the colour map on the crown (recomputes with the map). */
  setMap(map: CrownMapName | 'none'): void {
    useToolStore.getState().set({ crownMap: map });
    this.sync(useDesignStore.getState().activeStep);
  }

  setVisible(visible: boolean): void {
    useToolStore.getState().set({ crownVisible: visible });
    const step = useDesignStore.getState().activeStep;
    if (bridgeTool.handles()) bridgeTool.applyVisibility(step);
    else this.applyVisibility(step);
    frameworkTool.sync(step);
  }

  setOpacity(opacity: number): void {
    useToolStore.getState().set({ crownOpacity: opacity });
    this.viewer?.setObjectOpacity(CROWN_OBJECT_ID, opacity);
    bridgeTool.setOpacity(opacity);
    frameworkTool.sync(useDesignStore.getState().activeStep);
  }

  /**
   * Download the crown as binary STL, or the construction-info sidecar.
   * Separate actions: browsers block a second download started by one click.
   */
  export(kind: 'stl' | 'info'): string | null {
    const file = this.exportFile(kind);
    if (file && kind === 'stl') {
      const { doc, activeFdi } = useDesignStore.getState();
      markExported(bridgeOf(doc, activeFdi)?.teeth ?? [activeFdi], file);
    }
    return file;
  }

  private exportFile(kind: 'stl' | 'info'): string | null {
    // A bridge exports as one solid (the merged units and connectors).
    if (bridgeTool.handles()) return bridgeTool.export(kind);
    const ctx = toothContext();
    const last = this.last;
    if (!ctx || !last) return null;
    const { doc } = useDesignStore.getState();
    const caseRef = (doc.setup.patientRef || useSessionStore.getState().currentCase?.patientRef || 'case').replace(/[^\w.-]+/g, '_');
    const base = `${caseRef}-${ctx.fdi}`;
    // A reduced crown is delivered as its framework.
    if (kind === 'stl' && last.framework) return frameworkTool.exportFramework();
    if (kind === 'stl') {
      // An implant crown is exported with its screw channel.
      const solid = last.implant?.cut ?? last;
      downloadBytes(crownStl({ positions: solid.positions, indices: solid.indices }), `${base}.stl`, 'model/stl');
      return `${base}.stl`;
    }
    const info = { ...constructionInfo({ doc, tooth: ctx.tooth, appVersion: APP_VERSION, result: last }), ...frameworkTool.sidecar([{ fdi: ctx.fdi, framework: last.framework }]) };
    downloadBytes(JSON.stringify(info, null, 2), `${base}.construction.json`, 'application/json');
    return `${base}.construction.json`;
  }

  /**
   * Resolves once the displayed crown matches the current document (after
   * dispatches the recompute starts synchronously, so await this before
   * reading metrics). Null when there is no crown.
   */
  async settled(): Promise<CrownResult | null> {
    if (bridgeTool.handles()) {
      await bridgeTool.settled();
      return bridgeTool.activeUnit();
    }
    for (;;) {
      const pending = this.inflight;
      if (!pending) return this.last;
      await pending.catch(() => null);
      if (this.inflight === pending) {
        this.inflight = null;
        return this.last;
      }
    }
  }

  /**
   * Compute the crown (with maps) for the current document without changing
   * what is displayed, e.g. for design metrics. Null without a crown.
   */
  async evaluate(maps: CrownMapName[], extra: Pick<CrownRequest, 'overpress'> = {}): Promise<CrownResult | null> {
    const ctx = toothContext();
    if (!ctx?.tooth.crown) return null;
    if (bridgeTool.handles()) {
      // The active unit, designed with its bridge (connected sides have connectors, not contacts).
      const result = await bridgeTool.evaluate({ maps }).catch(() => null);
      return result?.units.find((u) => u.fdi === ctx.fdi) ?? null;
    }
    const req = crownRequest(ctx, true, 'none');
    if (!req) return null;
    return analysis.designCrownUnlatched({ ...req, maps, ...extra });
  }

  /** Current crown mesh (for tests and export); in a bridge, the active unit's. */
  current(): CrownResult | null {
    if (bridgeTool.handles()) return bridgeTool.activeUnit();
    return this.last;
  }

  private async compute(ctx: ToothContext, withPose: boolean): Promise<CrownResult | null> {
    const map = useToolStore.getState().crownMap;
    const req = crownRequest(ctx, withPose, map);
    if (!req) return null;
    const tools = useToolStore.getState();
    tools.set({ crown: { ...(tools.crown ?? { warnings: [] }), computing: true, error: undefined } });
    const run = analysis.designCrown(req);
    const tracked: Promise<CrownResult | null> = run.catch(() => null);
    this.inflight = tracked;
    try {
      const result = await run;
      this.last = result;
      this.cuspCentre = cuspCentroid(result);
      this.setMesh(result);
      this.applyPreview();
      this.applyMap(map, result);
      useToolStore.getState().set({
        crown: {
          computing: false,
          templateId: result.templateId,
          triangles: result.indices.length / 3,
          validation: result.validation,
          minAxialThicknessMm: result.minAxialThicknessMm,
          gapCheck: result.gapCheck,
          thickness: result.thickness,
          adapt: result.adapt,
          ...(result.inlay ? { inlay: result.inlay } : {}),
          warnings: result.warnings,
          ms: result.ms,
        },
      });
      for (const listener of this.listeners) listener();
      return result;
    } catch (e) {
      if (isStale(e)) return null;
      useToolStore.getState().set({ crown: { computing: false, error: errorText(e), warnings: [] } });
      return null;
    }
  }

  private applyMap(map: CrownMapName | 'none', result: CrownResult): void {
    const values = map === 'none' ? undefined : result.maps?.[map];
    const spec = map === 'none' ? null : legendFor(map);
    this.viewer?.setObjectScalars(CROWN_OBJECT_ID, values && spec ? values : null, spec ? { map: spec.map, range: spec.range, stops: spec.stops } : undefined);
    // Conflict markers (insufficient reduction / contact too tight) at the conflict centroids.
    const conflicts = Object.values(result.adapt ?? {}).flatMap((r) => (r?.conflict ? [r.conflict.at] : []));
    if (conflicts.length > 0) this.viewer?.overlays.setMarkers('crown:conflicts', conflicts, { color: '#d64545', outline: '#ffffff', sizePx: 16 });
    else this.viewer?.overlays.remove('crown:conflicts');
    if (useDesignStore.getState().activeStep !== 'axis') useToolStore.getState().set({ legend: values && spec ? spec : null });
  }

  /** Document pose minus the displayed result's pose, when they differ by a translation only (else zero). */
  private pendingMove(): V3 {
    const last = this.last;
    const crown = toothContext()?.tooth.crown;
    if (!last || crown?.kind !== 'template' || crown.templateId !== last.templateId) return ZERO;
    const a = crown.pose;
    const b = last.pose;
    if (!sameArray(a.quaternion, b.quaternion) || !sameArray(a.scale, b.scale)) return ZERO;
    return [a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]];
  }

  /**
   * Instant move feedback. The displayed crown is the last computed result;
   * while the document pose is that result's pose plus a translation (a
   * move, nudge or undo not recomputed yet), plus any gizmo drag, each vertex
   * is shifted by its move weight × the offset. The fit is linear in the pose
   * position, so this is what the recompute shows (up to thickness
   * enforcement), and the crown never snaps back while it runs.
   */
  private applyPreview(): void {
    const last = this.last;
    const g = this.geometry;
    if (!last || !g) return;
    const m = this.pendingMove();
    const d: V3 = [m[0] + this.dragOffset[0], m[1] + this.dragOffset[1], m[2] + this.dragOffset[2]];
    const moving = d[0] !== 0 || d[1] !== 0 || d[2] !== 0;
    if (!moving && !this.previewing) return;
    const attr = g.getAttribute('position') as BufferAttribute;
    const out = attr.array as Float32Array;
    const base = last.positions;
    const w = last.moveWeights;
    for (let v = 0; v < w.length; v++) {
      const k = w[v]!;
      out[v * 3] = base[v * 3]! + k * d[0];
      out[v * 3 + 1] = base[v * 3 + 1]! + k * d[1];
      out[v * 3 + 2] = base[v * 3 + 2]! + k * d[2];
    }
    attr.needsUpdate = true;
    g.computeBoundingSphere();
    this.previewing = moving;
    this.viewer?.requestRender();
  }

  private setMesh(result: CrownResult): void {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(result.positions.slice(), 3));
    g.setIndex(new BufferAttribute(result.indices.slice(), 1));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.geometry?.dispose();
    this.geometry = g;
    this.previewing = false;
    this.show();
  }

  private show(): void {
    if (!this.viewer || !this.geometry) return;
    this.viewer.addObject(CROWN_OBJECT_ID, this.geometry, { kind: 'restoration' });
    this.viewer.setObjectOpacity(CROWN_OBJECT_ID, useToolStore.getState().crownOpacity);
    this.applyVisibility(useDesignStore.getState().activeStep);
  }

  private applyVisibility(step: StepId): void {
    // No mesh (the crown was undone or rejected): nothing on screen, so no legend either.
    const visible = SHOW_CROWN.includes(step) && useToolStore.getState().crownVisible && this.geometry !== null;
    this.viewer?.setObjectVisible(CROWN_OBJECT_ID, visible);
    if (!visible) this.viewer?.overlays.remove('crown:conflicts');
    // The legend belongs to the crown map only while the crown is on screen (the axis step has its own).
    const { legend, crownMap } = useToolStore.getState();
    const isCrownLegend = crownMap !== 'none' && legend?.title === CROWN_MAPS[crownMap].title;
    if (!visible && isCrownLegend) useToolStore.getState().set({ legend: null });
    if (visible && crownMap !== 'none' && this.last?.maps?.[crownMap] && !isCrownLegend) {
      useToolStore.getState().set({ legend: legendFor(crownMap) });
    }
  }

  /** Remove the crown; `resetStatus` false leaves the status rows to bridgeTool (the active tooth is a bridge unit). */
  private clear(resetStatus = true): void {
    if (!this.geometry && !this.last) return;
    this.viewer?.removeObject(CROWN_OBJECT_ID);
    this.viewer?.overlays.remove('crown:conflicts');
    this.geometry?.dispose();
    this.geometry = null;
    this.last = null;
    this.cuspCentre = null;
    this.previewing = false;
    this.inputs = [];
    if (resetStatus) useToolStore.getState().set({ crown: null });
  }
}

/** Centroid of the vertices that follow a move fully (the cusps), or null if there are none. */
function cuspCentroid(result: CrownResult): V3 | null {
  const c: V3 = [0, 0, 0];
  let n = 0;
  for (let v = 0; v < result.moveWeights.length; v++) {
    if (result.moveWeights[v]! < CUSP_MOVE_WEIGHT) continue;
    c[0] += result.positions[v * 3]!;
    c[1] += result.positions[v * 3 + 1]!;
    c[2] += result.positions[v * 3 + 2]!;
    n++;
  }
  return n > 0 ? [c[0] / n, c[1] / n, c[2] / n] : null;
}

export const crownTool = new CrownTool();
