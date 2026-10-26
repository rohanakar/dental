import {
  bridgeOf,
  type BridgeDesign,
  type Command,
  type CrownAdapt,
  type DesignDocument,
  jawOf,
  type ScanRole,
  type StepId,
  type ToothDesign,
  type ToothFrame,
  unitKind,
} from '@dcad/shared';
import { BufferAttribute, BufferGeometry } from 'three';
import { create } from 'zustand';
import { activeAdapt } from '../design/adaptation';
import { useDesignStore } from '../design/store';
import type { InteractionHandler, Viewer } from '../engine/Viewer';
import { boundaryLoops } from '../geometry/meshValidate';
import { bridgeConstructionInfo, bridgeStl, downloadBytes } from '../io/exportCrown';
import { sceneController } from '../state/sceneController';
import { useSessionStore } from '../state/session';
import type { BridgeRequest, BridgeResultView, BridgeUnitRequest, BridgeUnitView, CrownMapName, CrownResult, FrameView } from '../workers/analysisTypes';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { errorText, fromMarginPoints } from './context';
import { frameworkFields, frameworkSidecar } from './frameworkRequest';
import { cutbackFor } from '../design/framework';
import { CROWN_MAPS, crownMapLegend } from './crownLegend';
import { implantMissing, implantRequestOf, isImplantTooth } from './implantTool';
import { type CrownStatus, type LegendSpec, useToolStore } from './toolStore';
import { isWing } from './wing';
import { inlayKey, inlayRequestOf } from './inlay';

/** One designed bridge: every unit and connector, plus the union and its checks when asked for (worker designBridge). */
export type BridgeResult = BridgeResultView;
export type BridgeUnitResult = BridgeUnitView;

type V3 = [number, number, number];
const v3 = (p: readonly number[]): V3 => [p[0]!, p[1]!, p[2]!];
const ZERO: V3 = [0, 0, 0];

const UNIT_PREFIX = 'bridge:unit:';
const CONNECTOR_PREFIX = 'bridge:connector:';
export const bridgeUnitObjectId = (fdi: number): string => `${UNIT_PREFIX}${fdi}`;
const connectorObjectId = ([a, b]: readonly [number, number]): string => `${CONNECTOR_PREFIX}${a}-${b}`;
/** Steps in which the restorations are shown (as for a single crown). */
const SHOW: readonly StepId[] = ['params', 'proposal', 'adapt', 'finalize'];
const ACTIVE_RIM = 'bridge:active';
const CONFLICTS = 'bridge:conflicts';
/** The active unit's cervical outline, in the app's accent (styles.css --accent). */
const ACTIVE_COLOR = '#2f6fde';
/** Vertices with at least this move weight count as cusps (they follow a move fully) for the gizmo anchor. */
const CUSP_MOVE_WEIGHT = 0.95;
const APP_VERSION = '0.3.0';

const sameArray = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- requests ---------------------------------------------------------------------------

interface BridgeContext {
  doc: DesignDocument;
  /** The tooth the bridge was looked up from (the active unit, for the display). */
  fdi: number;
  bridge: BridgeDesign;
  /** The bridge's units, in arch order. */
  units: ToothDesign[];
  jawRole: 'upper' | 'lower';
  jawSha: string | null;
  antagonistSha: string | null;
}

function contextFor(doc: DesignDocument, fdi: number, scans?: { jawSha: string; antagonistSha?: string }): BridgeContext | null {
  const bridge = bridgeOf(doc, fdi);
  if (!bridge) return null;
  const units = bridge.teeth.map((f) => doc.teeth.find((t) => t.fdi === f)).filter((t): t is ToothDesign => Boolean(t));
  const jawRole = jawOf(bridge.teeth[0]!);
  const antagonistRole: ScanRole = jawRole === 'upper' ? 'lower' : 'upper';
  return {
    doc,
    fdi,
    bridge,
    units,
    jawRole,
    jawSha: scans ? scans.jawSha : (sceneController.geometryFor(jawRole)?.sha256 ?? null),
    antagonistSha: scans ? (scans.antagonistSha ?? null) : (sceneController.geometryFor(antagonistRole)?.sha256 ?? null),
  };
}

const abutmentsOf = (ctx: BridgeContext) => ctx.units.filter((t) => unitKind(ctx.doc.setup, t.fdi) === 'abutment');
const materialOf = (ctx: BridgeContext) => ctx.doc.setup.teeth.find((t) => t.fdi === ctx.bridge.teeth[0])?.material ?? 'zirconia';
const listOf = (teeth: readonly ToothDesign[]) => teeth.map((t) => t.fdi).join(', ');

/** What the bridge still needs before it can be designed, or null. */
function missingInputs(ctx: BridgeContext): string | null {
  if (!ctx.jawSha) return `Load the ${ctx.jawRole} scan first.`;
  const abutments = abutmentsOf(ctx);
  const noFrame = abutments.filter((t) => !t.frame);
  if (noFrame.length) return `Set the tooth frame on ${listOf(noFrame)}.`;
  const noMargin = abutments.filter((t) => !t.margin && !isImplantTooth(ctx.doc, t.fdi));
  if (noMargin.length) return `Draw the margin on ${listOf(noMargin)}.`;
  const noImplant = implantMissing(ctx.doc, abutments);
  if (noImplant) return noImplant;
  if (abutments.some((t) => !t.axis)) return `Set the common insertion axis of ${listOf(abutments)}.`;
  return null;
}

export interface BridgeRequestOptions {
  /** Send the stored poses (default). false proposes every unit, as "Propose bridge" does. */
  withPoses?: boolean;
  maps?: CrownMapName[];
  /** Merge into one solid and run the bridge checks (QA and export; slower than a plain design). */
  union?: boolean;
  /**
   * Adaptation per unit: 'active' (default) = the stored targets while the unit's adapt step is done (as the display
   * does), 'none', or explicit targets per tooth (units not listed get none). Sides facing a connected unit are always
   * ignored by the worker.
   */
  adapt?: 'active' | 'none' | Partial<Record<number, CrownAdapt>>;
  /** Scans to design on; default = the scans loaded in the viewer for the bridge's jaw and its antagonist. */
  scans?: { jawSha: string; antagonistSha?: string };
}

/** A stored tooth frame as the worker takes it (no source; contacts only when present). */
export function frameView(f: Pick<ToothFrame, 'origin' | 'occlusal' | 'mesial' | 'buccal' | 'mesialContact' | 'distalContact'>): FrameView {
  return {
    origin: v3(f.origin),
    occlusal: v3(f.occlusal),
    mesial: v3(f.mesial),
    buccal: v3(f.buccal),
    ...(f.mesialContact ? { mesialContact: v3(f.mesialContact) } : {}),
    ...(f.distalContact ? { distalContact: v3(f.distalContact) } : {}),
  };
}

function buildRequest(ctx: BridgeContext, opts: BridgeRequestOptions): BridgeRequest {
  const { doc } = ctx;
  const abutments = abutmentsOf(ctx);
  // All abutments store the same (common) axis; prefer the tooth the request was made for.
  const axis = (abutments.find((t) => t.fdi === ctx.fdi && t.axis) ?? abutments.find((t) => t.axis))!.axis!;
  const units = ctx.units.map((t): BridgeUnitRequest => {
    const kind = unitKind(doc.setup, t.fdi);
    const crown = t.crown?.kind === 'template' ? t.crown : undefined;
    const adapt = opts.adapt === 'none' ? undefined : opts.adapt === undefined || opts.adapt === 'active' ? activeAdapt(t) : opts.adapt[t.fdi];
    // A pontic placed by a click on the ridge (a manual frame) keeps that centre in every proposal; otherwise the
    // proposal is centred by the layout on the retainer shells and the stored frame gives only the axes.
    const centre = kind === 'pontic' && t.frame?.source === 'manual' ? v3(t.frame.origin) : undefined;
    const inlay = kind === 'pontic' ? undefined : inlayRequestOf(doc, t.fdi);
    return {
      fdi: t.fdi,
      kind,
      params: t.params,
      ...(t.frame ? { frame: frameView(t.frame) } : {}),
      ...(centre ? { centre } : {}),
      ...(kind !== 'pontic' && t.margin ? { margin: fromMarginPoints(t.margin.points) } : {}),
      ...(isWing(doc.setup, t.fdi) ? { wing: true } : {}),
      ...(inlay ? { inlay } : {}),
      ...(t.implant ? { implant: implantRequestOf(t) } : {}),
      ...(opts.withPoses !== false && crown ? { pose: crown.pose } : {}),
      ...(adapt ? { adapt } : {}),
      ...frameworkFields(doc, t.fdi),
    };
  });
  return {
    jawSha: ctx.jawSha!,
    ...(ctx.antagonistSha ? { antagonistSha: ctx.antagonistSha } : {}),
    material: materialOf(ctx),
    axis: v3(axis.direction),
    units,
    connectors: ctx.bridge.connectors,
    ...(opts.maps?.length ? { maps: opts.maps } : {}),
    ...(opts.union ? { union: true } : {}),
  };
}

/**
 * The worker request (analysis.designBridge) for the bridge that contains `fdi`, built from a document and the loaded
 * scans, so proposers can design a bridge without dispatching. Null when `fdi` is not in a bridge; throws an Error
 * naming what is missing (scan, abutment frame, margin or the common axis).
 */
export function bridgeRequest(doc: DesignDocument, fdi: number, opts: BridgeRequestOptions = {}): BridgeRequest | null {
  const ctx = contextFor(doc, fdi, opts.scans);
  if (!ctx) return null;
  const missing = missingInputs(ctx);
  if (missing) throw new Error(`Bridge ${ctx.bridge.teeth[0]}–${ctx.bridge.teeth.at(-1)}: ${missing}`);
  return buildRequest(ctx, opts);
}

/**
 * Commands that store a bridge proposal (designBridge without poses): a pontic gets the frame it was laid out in on
 * the retainer shells (where its proposed pose is centred), unless its centre was clicked (a manual frame); then every
 * unit gets its template pose. Dispatch them as one batch: one undo entry.
 */
export function bridgeProposalCommands(doc: DesignDocument, result: BridgeResult): Command[] {
  const cmds: Command[] = [];
  for (const u of result.units) {
    const tooth = doc.teeth.find((t) => t.fdi === u.fdi);
    if (u.kind === 'pontic' && tooth?.frame?.source !== 'manual') {
      // The axes it was designed with, at the origin its pose was centred on.
      const origin = u.layout?.frame.origin ?? u.frame.origin;
      cmds.push({ type: 'setFrame', fdi: u.fdi, frame: { ...u.frame, origin, source: 'auto' } });
    }
    cmds.push({ type: 'setCrown', fdi: u.fdi, crown: { kind: 'template', templateId: u.templateId, pose: u.pose } });
  }
  return cmds;
}

/** Everything the displayed bridge depends on; a change of any entry recomputes it. */
function inputsOf(ctx: BridgeContext, map: string): unknown[] {
  return [
    ctx.jawSha,
    ctx.antagonistSha,
    ctx.bridge,
    materialOf(ctx),
    ...ctx.units.flatMap((t) => [t.frame, t.margin, t.axis, t.params, t.crown, t.steps.adapt, t.implant, t.screwChannel, cutbackFor(ctx.doc, t.fdi), inlayKey(ctx.doc, t.fdi)]),
    map,
  ];
}

/** The status rows (CrownStatusView, readiness) of one unit. */
export function unitStatus(unit: CrownResult, computing = false): CrownStatus {
  return {
    computing,
    templateId: unit.templateId,
    triangles: unit.indices.length / 3,
    validation: unit.validation,
    minAxialThicknessMm: unit.minAxialThicknessMm,
    gapCheck: unit.gapCheck,
    thickness: unit.thickness,
    adapt: unit.adapt,
    ...(unit.inlay ? { inlay: unit.inlay } : {}),
    warnings: unit.warnings,
    ms: unit.ms,
  };
}

/** A crown map's legend for one unit (its own params and adaptation targets). */
function legendFor(map: CrownMapName, tooth: ToothDesign | undefined): LegendSpec {
  if (!tooth) return CROWN_MAPS[map];
  const adapt = tooth.crown?.kind === 'template' ? tooth.crown.adapt : undefined;
  return crownMapLegend(map, tooth.params, { occlusion: adapt?.occlusion?.clearanceMm, contact: adapt?.mesial?.targetMm ?? adapt?.distal?.targetMm });
}

/** Centroid of the vertices that follow a move fully (the cusps), or null. */
function cuspCentroid(unit: CrownResult): V3 | null {
  const c: V3 = [0, 0, 0];
  let n = 0;
  for (let v = 0; v < unit.moveWeights.length; v++) {
    if (unit.moveWeights[v]! < CUSP_MOVE_WEIGHT) continue;
    c[0] += unit.positions[v * 3]!;
    c[1] += unit.positions[v * 3 + 1]!;
    c[2] += unit.positions[v * 3 + 2]!;
    n++;
  }
  return n > 0 ? [c[0] / n, c[1] / n, c[2] / n] : null;
}

/** The cervical outline of a unit: the boundary of its fitting surface (intaglio or pontic base), xyz packed. */
function rimOf(unit: CrownResult): Float32Array | null {
  const n = unit.intaglioVertices;
  const idx = unit.indices;
  const tris: number[] = [];
  for (let f = 0; f < idx.length; f += 3) if (idx[f]! < n && idx[f + 1]! < n && idx[f + 2]! < n) tris.push(idx[f]!, idx[f + 1]!, idx[f + 2]!);
  let loop: Uint32Array | undefined;
  for (const l of boundaryLoops({ positions: unit.positions, indices: Uint32Array.from(tris) })) if (!loop || l.length > loop.length) loop = l;
  if (!loop || loop.length < 3) return null;
  const out = new Float32Array(loop.length * 3);
  loop.forEach((v, i) => out.set(unit.positions.subarray(v * 3, v * 3 + 3), i * 3));
  return out;
}

// ---- state for the step panels ---------------------------------------------------------------

export interface BridgeCheckState {
  running: boolean;
  /** The last union check: designBridge with union: true (the merged solid and the checks measured on it). */
  result: BridgeResult | null;
  error: string | null;
  /** The check was made on the current document. */
  current: boolean;
}

export interface BridgeViewState {
  /** The active tooth's bridge (arch order), or null when it is a single crown. */
  teeth: number[] | null;
  /** What the bridge still needs before it can be designed (frames, margins, the common axis, the scan). */
  missing: string | null;
  /** The displayed design: every unit and connector of the active tooth's bridge. */
  result: BridgeResult | null;
  computing: boolean;
  error: string | null;
  check: BridgeCheckState;
}

const NO_CHECK: BridgeCheckState = { running: false, result: null, error: null, current: false };

export const useBridgeStore = create<BridgeViewState>()(() => ({ teeth: null, missing: null, result: null, computing: false, error: null, check: NO_CHECK }));
const setStore = (patch: Partial<BridgeViewState>) => useBridgeStore.setState(patch);

// ---- the tool ---------------------------------------------------------------------------------

/**
 * The bridge counterpart of crownTool: while the active tooth is a unit of a bridge, every unit and connector is
 * derived data, designed in the worker (analysis.designBridge, cached per unit) whenever any input changes and shown
 * together. The active unit carries the move preview, the gizmo anchor, the status rows and the legend, and is
 * outlined; clicking another unit makes it active. crownTool delegates here for bridges, so single crowns are
 * unchanged.
 */
class BridgeTool {
  private viewer: Viewer | null = null;
  private inputs: unknown[] = [];
  private last: BridgeResult | null = null;
  private inflight: Promise<BridgeResult | null> | null = null;
  private computing = false;
  /** Bumped when the display is cleared, so a design still in flight is dropped. */
  private generation = 0;
  private readonly geometries = new Map<string, BufferGeometry>();
  private cusps = new Map<number, V3 | null>();
  private rims = new Map<number, Float32Array | null>();
  /** Translation previewed on the active unit while the gizmo is dragged (world mm). */
  private dragOffset: V3 = ZERO;
  /** Unit whose displayed positions differ from its result (a move preview is on screen). */
  private previewing: number | null = null;
  /** The status this tool last put in toolStore.crown. */
  private status: CrownStatus | null = null;
  private shownActive: number | null = null;
  private visible = false;
  private checkInputs: unknown[] = [];
  private checkGeneration = 0;
  private readonly listeners = new Set<() => void>();

  attach(viewer: Viewer | null): void {
    this.viewer = viewer;
    this.inputs = [];
    this.shownActive = null;
    if (viewer && this.last) this.setMeshes(this.last);
  }

  /** The active tooth is a unit of a bridge: crownTool hands the display over to this tool. */
  handles(): boolean {
    const { doc, activeFdi } = useDesignStore.getState();
    return Boolean(bridgeOf(doc, activeFdi));
  }

  /** Called on every store change while the active tooth is in a bridge (from crownTool.sync). */
  sync(step: StepId): void {
    const { doc, activeFdi } = useDesignStore.getState();
    const ctx = contextFor(doc, activeFdi);
    if (!ctx) {
      this.clear();
      return;
    }
    const missing = missingInputs(ctx);
    const state = useBridgeStore.getState();
    if (state.missing !== missing || !state.teeth || !sameArray(state.teeth, ctx.bridge.teeth)) setStore({ missing, teeth: [...ctx.bridge.teeth] });
    const hasCrown = ctx.units.some((t) => t.crown);
    if (!hasCrown || missing) {
      this.clearDesign(hasCrown ? missing : null);
    } else {
      const map = useToolStore.getState().crownMap;
      const inputs = inputsOf(ctx, map);
      if (!sameArray(inputs, this.inputs)) {
        this.inputs = inputs;
        void this.compute(buildRequest(ctx, { maps: map === 'none' ? undefined : [map] }));
        // Until the recompute lands, show the move at once (see applyPreview).
        this.applyPreview();
      }
    }
    if (this.shownActive !== activeFdi) this.applyActive();
    if (useToolStore.getState().crown !== this.status) useToolStore.getState().set({ crown: this.status });
    this.applyVisibility(step);
    this.updateCheck(ctx);
  }

  /** Called after each newly displayed bridge result. Returns an unsubscribe function. */
  onResult(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The bridge request for a document (see bridgeRequest). */
  request(doc: DesignDocument, fdi: number, opts: BridgeRequestOptions = {}): BridgeRequest | null {
    return bridgeRequest(doc, fdi, opts);
  }

  /**
   * Resolves once the displayed bridge matches the current document (the recompute starts synchronously on each
   * dispatch, so await this before reading results). Null when the active tooth is not in a bridge or nothing is
   * placed yet.
   */
  async settled(): Promise<BridgeResult | null> {
    for (;;) {
      const pending = this.inflight;
      if (!pending) break;
      await pending.catch(() => null);
      if (this.inflight === pending) {
        this.inflight = null;
        break;
      }
    }
    return this.handles() ? this.last : null;
  }

  /**
   * Design the active tooth's bridge for the current document without touching the display, e.g. for metrics or a
   * QA gate; `union: true` also merges it and runs the bridge checks. Null when the active tooth is not in a bridge;
   * throws when the bridge is missing an input (see bridgeRequest).
   */
  async evaluate(opts: { union?: boolean; maps?: CrownMapName[] } = {}): Promise<BridgeResult | null> {
    const { doc, activeFdi } = useDesignStore.getState();
    const request = bridgeRequest(doc, activeFdi, { union: opts.union, maps: opts.maps });
    return request ? analysis.designBridgeUnlatched(request) : null;
  }

  /** The displayed bridge (null when none is shown). */
  current(): BridgeResult | null {
    return this.handles() ? this.last : null;
  }

  /** The active unit of the displayed bridge. */
  activeUnit(): BridgeUnitResult | null {
    const fdi = useDesignStore.getState().activeFdi;
    return this.current()?.units.find((u) => u.fdi === fdi) ?? null;
  }

  /**
   * "Propose bridge": design every unit without stored poses (retainers on their margins, pontics along the arch
   * between them, all on the common axis) and store the result as one batch, one undo entry. Returns false (with a
   * message) when the bridge is missing an input.
   */
  async propose(): Promise<boolean> {
    const { doc, activeFdi } = useDesignStore.getState();
    const tools = useToolStore.getState();
    let request: BridgeRequest | null;
    try {
      request = bridgeRequest(doc, activeFdi, { withPoses: false, adapt: 'none' });
    } catch (e) {
      tools.set({ message: { kind: 'warning', text: errorText(e) } });
      return false;
    }
    if (!request) return false;
    tools.set({ busy: 'Proposing the bridge…', message: null });
    try {
      const result = await analysis.designBridgeUnlatched(request);
      useDesignStore.getState().dispatch(bridgeProposalCommands(useDesignStore.getState().doc, result));
      return true;
    } catch (e) {
      useToolStore.getState().set({ message: { kind: 'error', text: `Could not propose the bridge: ${errorText(e)}` } });
      return false;
    } finally {
      useToolStore.getState().set({ busy: null });
    }
  }

  /**
   * Merge the active tooth's bridge into one solid and run the bridge checks (connector sections, height, one closed
   * solid, seating, pontic base). The result is kept for the Adapt and Finalize steps and for export while the
   * document does not change.
   */
  async check(): Promise<BridgeResult | null> {
    const { doc, activeFdi } = useDesignStore.getState();
    const ctx = contextFor(doc, activeFdi);
    if (!ctx) return null;
    const missing = missingInputs(ctx);
    if (missing) {
      setStore({ check: { ...NO_CHECK, error: missing } });
      return null;
    }
    const inputs = inputsOf(ctx, '');
    const generation = ++this.checkGeneration;
    setStore({ check: { ...useBridgeStore.getState().check, running: true, error: null } });
    try {
      const result = await analysis.designBridgeUnlatched(buildRequest(ctx, { union: true }));
      if (generation !== this.checkGeneration) return result;
      this.checkInputs = inputs;
      const now = contextFor(useDesignStore.getState().doc, useDesignStore.getState().activeFdi);
      setStore({ check: { running: false, result, error: result.unionError ?? null, current: Boolean(now && sameArray(inputsOf(now, ''), inputs)) } });
      return result;
    } catch (e) {
      if (generation === this.checkGeneration) setStore({ check: { running: false, result: null, error: errorText(e), current: false } });
      return null;
    }
  }

  /**
   * Download the merged bridge as one binary STL (`<ref>-<first>-<last>-bridge.stl`), or its construction sidecar.
   * Needs a current check (the union is what is exported). Returns the file name, or null.
   */
  export(kind: 'stl' | 'info'): string | null {
    const { check, teeth } = useBridgeStore.getState();
    const result = check.current ? check.result : null;
    if (!result?.union || !teeth) return null;
    const { doc } = useDesignStore.getState();
    const caseRef = (doc.setup.patientRef || useSessionStore.getState().currentCase?.patientRef || 'case').replace(/[^\w.-]+/g, '_');
    // With reduced units the merged solid is the framework bridge.
    const base = `${caseRef}-${teeth[0]}-${teeth.at(-1)}-${result.units.some((u) => u.framework) ? 'framework' : 'bridge'}`;
    if (kind === 'stl') {
      downloadBytes(bridgeStl({ positions: result.union.positions, indices: result.union.indices }), `${base}.stl`, 'model/stl');
      return `${base}.stl`;
    }
    const info = { ...bridgeConstructionInfo({ doc, teeth, appVersion: APP_VERSION, result }), ...frameworkSidecar(result) };
    downloadBytes(JSON.stringify(info, null, 2), `${base}.construction.json`, 'application/json');
    return `${base}.construction.json`;
  }

  /** Clicking a unit in the viewport makes it the active tooth. */
  interaction(jawRole: ScanRole): InteractionHandler {
    return {
      targets: () => [jawRole, ...[...this.geometries.keys()].filter((id) => id.startsWith(UNIT_PREFIX))],
      onClick: (hit) => {
        if (!hit?.objectId.startsWith(UNIT_PREFIX)) return;
        const fdi = Number(hit.objectId.slice(UNIT_PREFIX.length));
        if (fdi !== useDesignStore.getState().activeFdi) useDesignStore.getState().setActiveFdi(fdi);
      },
    };
  }

  /** Preview a gizmo drag on the active unit (deformed like the fit: the margin stays, the cusps follow). */
  previewDrag(delta: readonly number[] | null): void {
    this.dragOffset = delta ? v3(delta) : ZERO;
    this.applyPreview();
  }

  /** Where the move gizmo sits: the active unit's cusps, plus any move not recomputed yet. */
  gizmoAnchor(): V3 | null {
    const unit = this.activeUnit();
    const c = unit && this.cusps.get(unit.fdi);
    if (!unit || !c) return null;
    const m = this.pendingMove(unit);
    return [c[0] + m[0], c[1] + m[1], c[2] + m[2]];
  }

  setOpacity(opacity: number): void {
    for (const id of this.geometries.keys()) this.viewer?.setObjectOpacity(id, opacity);
  }

  applyVisibility(step: StepId): void {
    const visible = SHOW.includes(step) && useToolStore.getState().crownVisible && this.geometries.size > 0;
    for (const id of this.geometries.keys()) this.viewer?.setObjectVisible(id, visible);
    if (visible !== this.visible) {
      this.visible = visible;
      this.drawOverlays();
    }
    // The legend belongs to the crown map only while the restorations are on screen (the axis step has its own).
    const { legend, crownMap } = useToolStore.getState();
    const isCrownLegend = crownMap !== 'none' && legend?.title === CROWN_MAPS[crownMap].title;
    if (!visible && isCrownLegend) useToolStore.getState().set({ legend: null });
    if (visible && crownMap !== 'none' && this.activeUnit()?.maps?.[crownMap] && !isCrownLegend) {
      useToolStore.getState().set({ legend: this.legendForActive(crownMap) });
    }
  }

  /** Remove the bridge from the view (the active tooth is not in a bridge). */
  clear(): void {
    this.clearDesign(null);
    const state = useBridgeStore.getState();
    if (state.teeth || state.missing) setStore({ teeth: null, missing: null, check: { ...state.check, current: false } });
  }

  // ---- internals ----------------------------------------------------------------------------

  private async compute(request: BridgeRequest): Promise<BridgeResult | null> {
    const generation = this.generation;
    this.computing = true;
    this.status = { ...(this.status ?? { warnings: [] }), computing: true, error: undefined };
    useToolStore.getState().set({ crown: this.status });
    setStore({ computing: true, error: null });
    const run = analysis.designBridge(request);
    const tracked: Promise<BridgeResult | null> = run.catch(() => null);
    this.inflight = tracked;
    try {
      const result = await run;
      if (generation !== this.generation) return null;
      this.computing = false;
      this.last = result;
      this.setMeshes(result);
      this.applyPreview();
      this.applyActive();
      useToolStore.getState().set({ crown: this.status });
      setStore({ result, computing: false, error: null });
      for (const listener of this.listeners) listener();
      return result;
    } catch (e) {
      if (isStale(e) || generation !== this.generation) return null;
      this.computing = false;
      this.status = { computing: false, error: errorText(e), warnings: [] };
      useToolStore.getState().set({ crown: this.status });
      setStore({ computing: false, error: errorText(e) });
      return null;
    }
  }

  /** Remove the meshes; `error` explains why nothing is shown (null = nothing to show yet). */
  private clearDesign(error: string | null): void {
    const status: CrownStatus | null = error ? { computing: false, error, warnings: [] } : null;
    if (!this.last && this.geometries.size === 0 && !this.computing && this.status?.error === status?.error) return;
    this.generation++;
    this.computing = false;
    this.inflight = null;
    for (const id of this.geometries.keys()) this.viewer?.removeObject(id);
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
    this.viewer?.overlays.remove(ACTIVE_RIM);
    this.viewer?.overlays.remove(CONFLICTS);
    this.last = null;
    this.inputs = [];
    this.cusps.clear();
    this.rims.clear();
    this.previewing = null;
    this.shownActive = null;
    this.visible = false;
    this.status = status;
    useToolStore.getState().set({ crown: status });
    setStore({ result: null, computing: false, error });
  }

  private setMeshes(result: BridgeResult): void {
    const old = new Map(this.geometries);
    this.geometries.clear();
    const add = (id: string, positions: Float32Array, indices: Uint32Array) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(positions, 3));
      g.setIndex(new BufferAttribute(indices, 1));
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      this.geometries.set(id, g);
      this.viewer?.addObject(id, g, { kind: 'restoration' });
    };
    // Unit positions are copied: the move preview writes into the displayed copy, the result stays the base.
    for (const u of result.units) add(bridgeUnitObjectId(u.fdi), u.positions.slice(), u.indices);
    for (const c of result.connectors) add(connectorObjectId(c.between), c.positions, c.indices);
    for (const [id, g] of old) {
      if (!this.geometries.has(id)) this.viewer?.removeObject(id);
      g.dispose();
    }
    this.cusps = new Map(result.units.map((u) => [u.fdi, cuspCentroid(u)]));
    this.rims.clear();
    this.previewing = null;
    this.setOpacity(useToolStore.getState().crownOpacity);
    this.applyVisibility(useDesignStore.getState().activeStep);
  }

  /** The active unit changed or a new result arrived: status rows, colour maps, legend and outline. */
  private applyActive(): void {
    const fdi = useDesignStore.getState().activeFdi;
    if (this.previewing !== null && this.previewing !== fdi) this.resetPositions(this.previewing);
    this.shownActive = fdi;
    const unit = this.last?.units.find((u) => u.fdi === fdi);
    if (unit) this.status = unitStatus(unit, this.computing);
    else if (this.last) this.status = { computing: this.computing, warnings: [] };
    this.paint();
    this.drawOverlays();
  }

  private legendForActive(map: CrownMapName): LegendSpec {
    const { doc, activeFdi } = useDesignStore.getState();
    return legendFor(map, doc.teeth.find((t) => t.fdi === activeFdi));
  }

  /** Colour maps per unit (each with its own legend stops), and the active unit's legend. */
  private paint(): void {
    const result = this.last;
    if (!result) return;
    const map = useToolStore.getState().crownMap;
    const { doc, activeFdi } = useDesignStore.getState();
    for (const u of result.units) {
      const values = map === 'none' ? undefined : u.maps?.[map];
      const spec = map === 'none' ? null : legendFor(map, doc.teeth.find((t) => t.fdi === u.fdi));
      this.viewer?.setObjectScalars(bridgeUnitObjectId(u.fdi), values && spec ? values : null, spec ? { map: spec.map, range: spec.range, stops: spec.stops } : undefined);
    }
    // The legend follows the active unit, while the restorations are on screen (applyVisibility handles the rest).
    if (!this.visible) return;
    const active = result.units.find((u) => u.fdi === activeFdi);
    const values = map === 'none' ? undefined : active?.maps?.[map];
    useToolStore.getState().set({ legend: values && map !== 'none' ? this.legendForActive(map) : null });
  }

  /** The active unit's outline and the adaptation conflicts of every unit, while the restorations are shown. */
  private drawOverlays(): void {
    const o = this.viewer?.overlays;
    if (!o) return;
    const unit = this.visible ? this.activeUnit() : null;
    let rim = unit ? this.rims.get(unit.fdi) : undefined;
    if (unit && rim === undefined) {
      rim = rimOf(unit);
      this.rims.set(unit.fdi, rim);
    }
    // Drawn on top: the rim sits at the margin, behind the unit's own margin band from most views.
    if (rim) o.setPolyline(ACTIVE_RIM, rim, { color: ACTIVE_COLOR, widthPx: 2.5, closed: true, depthTest: false, opacity: 0.9 });
    else o.remove(ACTIVE_RIM);
    const conflicts = this.visible ? (this.last?.units ?? []).flatMap((u) => Object.values(u.adapt ?? {}).flatMap((r) => (r?.conflict ? [r.conflict.at] : []))) : [];
    if (conflicts.length > 0) o.setMarkers(CONFLICTS, conflicts, { color: '#d64545', outline: '#ffffff', sizePx: 16 });
    else o.remove(CONFLICTS);
  }

  /** Document pose of a unit minus its displayed pose, when they differ by a translation only (else zero). */
  private pendingMove(unit: BridgeUnitResult): V3 {
    const crown = useDesignStore.getState().doc.teeth.find((t) => t.fdi === unit.fdi)?.crown;
    if (crown?.kind !== 'template' || crown.templateId !== unit.templateId) return ZERO;
    const a = crown.pose;
    const b = unit.pose;
    if (!sameArray(a.quaternion, b.quaternion) || !sameArray(a.scale, b.scale)) return ZERO;
    return [a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]];
  }

  /** Instant move feedback on the active unit, as crownTool.applyPreview does for a single crown. */
  private applyPreview(): void {
    const unit = this.activeUnit();
    const g = unit && this.geometries.get(bridgeUnitObjectId(unit.fdi));
    if (!unit || !g) return;
    const m = this.pendingMove(unit);
    const d: V3 = [m[0] + this.dragOffset[0], m[1] + this.dragOffset[1], m[2] + this.dragOffset[2]];
    const moving = d[0] !== 0 || d[1] !== 0 || d[2] !== 0;
    if (!moving && this.previewing !== unit.fdi) return;
    const attr = g.getAttribute('position') as BufferAttribute;
    const out = attr.array as Float32Array;
    const base = unit.positions;
    const w = unit.moveWeights;
    for (let v = 0; v < w.length; v++) {
      const k = w[v]!;
      out[v * 3] = base[v * 3]! + k * d[0];
      out[v * 3 + 1] = base[v * 3 + 1]! + k * d[1];
      out[v * 3 + 2] = base[v * 3 + 2]! + k * d[2];
    }
    attr.needsUpdate = true;
    g.computeBoundingSphere();
    this.previewing = moving ? unit.fdi : null;
    this.viewer?.requestRender();
  }

  private resetPositions(fdi: number): void {
    const unit = this.last?.units.find((u) => u.fdi === fdi);
    const g = this.geometries.get(bridgeUnitObjectId(fdi));
    if (unit && g) {
      const attr = g.getAttribute('position') as BufferAttribute;
      (attr.array as Float32Array).set(unit.positions);
      attr.needsUpdate = true;
      g.computeBoundingSphere();
      this.viewer?.requestRender();
    }
    this.previewing = null;
  }

  private updateCheck(ctx: BridgeContext): void {
    const current = this.checkInputs.length > 0 && sameArray(inputsOf(ctx, ''), this.checkInputs);
    const { check } = useBridgeStore.getState();
    if (check.current !== current) setStore({ check: { ...check, current } });
  }
}

export const bridgeTool = new BridgeTool();
