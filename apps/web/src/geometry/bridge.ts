import {
  archIndex,
  BRIDGE_PRESETS,
  facingSide,
  MARYLAND_CONNECTOR_MIN_AREA_MM2,
  minConnectorAreaMm2,
  type ConnectorDesign,
  type CrownAdapt,
  type Cutback,
  type DesignParams,
  type Material,
  type Pose,
  type ProximalSide,
  type UnitKind,
} from '@dcad/shared';
import { fitArchCurve, type ArchCurve } from './arch';
import { checkBridgeUnion, type BridgeChecks } from './bridgeUnion';
import { designConnector, type ConnectorGeometry, type ConnectorUnit } from './connectors';
import { designCrown, proposeCrownPoseFor, type CrownDesign, type CrownFrame, type CrownInput } from './crown';
import type { CrownMapName } from './crownMaps';
import { templateForTooth, type CrownTemplate } from './crownTemplate';
import { applyFrameworks, assemblyMesh, bridgeOverpress, type UnitFramework, type UnitOverpress } from './framework';
import type { IndexedMesh } from './mesh';
import { meshBooleanReady, unionMeshes } from './meshBoolean';
import { principalAxes, type V3 } from './pca';
import { designPontic, proposePonticPose, type PonticBaseGap } from './pontic';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import type { IntaglioSurface } from './thickness';
import { findNeighbourContacts, isFrontTooth, mesialFromBuccal } from './toothFrame';
import { designWingUnit, type WingUnitReport } from './wingUnit';
import { designInlayUnit, type InlayUnitReport } from './inlayUnit';
import { inlayBridgeIndications, type InlayType, type OuterSource, type PreopScan } from './inlay';
import { fittingSurfaceOf, type FittingPatch } from './patchRetainer';
import { implantRetainer, implantUnitWidths, unionMeshOf, channelCount } from './implantBridge';
import type { ImplantUnit } from './implantCrown';
import { implantToWorld } from './implantLibrary';

/**
 * Bridges: one solid of retainers (crowns on the abutments), pontics over the
 * ridge and connectors between neighbouring units, seated along one common
 * insertion axis (searchCommonAxis). See specs/2026-10-25-bridge-mode.md.
 *
 * - layoutPontics: pontic frames along the arch curve (no click needed).
 * - designBridge: retainers → pontics (sized to the gap between the retainer
 *   shells) → connectors → optionally the union and its checks
 *   (bridgeUnion.ts). Units are dispatched on their role (UnitKind), never on
 *   the restoration type, so other unit geometries plug in here.
 */

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const reject = (a: V3, n: V3): V3 => sub(a, scale(n, dot(a, n)));
const pointAt = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/**
 * Directions for fitting a jaw's arch curve from its abutment frames: occlusal
 * = the mean of their occlusal directions; buccal hint = the sum of their
 * buccal directions (not one frame's: on a straight quadrant scan the hint
 * decides which side is buccal, so one flipped frame must not decide it).
 * Fit unhinted and orient per call (orientArchCurve) when the fit is cached.
 *
 * A front-tooth frame (`fdi` at positions 1–3) leans with its prep
 * (estimateToothFrame), so with one among the frames and the jaw's
 * `positions` given, the occlusal is the jaw's occlusal-plane normal instead:
 * the whole-jaw PCA least-variance axis (the one the jaw-level frame starts
 * from), oriented along the mean, when it is within 35° of it. Without a
 * front tooth the mean stays, so posterior bridges are unchanged.
 */
export function archFitDirections(frames: ReadonlyArray<{ occlusal: V3; buccal: V3; fdi?: number }>, positions?: Float32Array): { occlusal: V3; buccalHint?: V3 } {
  if (frames.length === 0) throw new Error('A bridge needs an abutment frame to fit the arch curve');
  let occlusal: V3 = [0, 0, 0];
  let buccal: V3 = [0, 0, 0];
  for (const f of frames) {
    occlusal = add(occlusal, normalize(f.occlusal));
    buccal = add(buccal, normalize(f.buccal));
  }
  occlusal = normalize(occlusal);
  if (positions && frames.some((f) => f.fdi !== undefined && isFrontTooth(f.fdi))) {
    const plane = principalAxes(positions, 50_000).axes[2];
    const along = dot(plane, occlusal);
    if (Math.abs(along) >= Math.cos((35 * Math.PI) / 180)) occlusal = along >= 0 ? plane : scale(plane, -1);
  }
  return { occlusal, ...(Math.hypot(...buccal) > 1e-6 ? { buccalHint: normalize(buccal) } : {}) };
}

// ---- Pontic layout ---------------------------------------------------------------

export interface LayoutUnit {
  fdi: number;
  kind: UnitKind;
  /** Units that are not pontics: their frame (occlusal and buccal feed the pontic frames). */
  frame?: Pick<CrownFrame, 'origin' | 'occlusal' | 'buccal'>;
  /**
   * Units that are not pontics: outline points, xyz packed (the margin before the crown exists, the outer shell
   * after). Their extremes along the arch are the unit's facing edges. Without it, the unit spans its template's
   * nominal width around the frame origin.
   */
  outline?: Float32Array;
  /** Pontics: centre override (a click on the ridge). */
  centre?: V3;
}

export interface PonticLayout {
  fdi: number;
  /** Origin on the ridge under the centre; occlusal = mean of the neighbouring units; mesial by FDI handedness. */
  frame: CrownFrame;
  /** Arc length of the centre on the arch curve. */
  s: number;
  /** Arc lengths of the pontic's span ends: toward the lower, then the higher arch index. */
  span: [number, number];
  /** Mesio-distal width the arch gives it (mm). */
  mdMm: number;
  /** In a run of pontics connected on one side only. */
  cantilever: boolean;
  warnings: string[];
  /**
   * The abutment frames around the run disagree with the case's teeth: in the wrong order along the arch, or much
   * further apart than the pontics between them need (a frame on the wrong prep). Holds before the margins exist.
   */
  frameCheck?: string;
}

/** Abutment frames further apart than this times the pontics' nominal width are taken to be on the wrong teeth. */
const FRAME_SPAN_FACTOR = 1.6;

interface Extent {
  min: number;
  max: number;
  minPoint: V3;
  maxPoint: V3;
}

/** Proximal side of a tooth that faces the lower ('before') or higher ('after') arch index. */
function sideToward(fdi: number, after: boolean): ProximalSide {
  const q = Math.floor(fdi / 10);
  // archIndex grows toward mesial in quadrants 1 and 4, toward distal in 2 and 3.
  return after === (q === 1 || q === 4) ? 'mesial' : 'distal';
}

/**
 * Frames for the pontics of one bridge (units in arch order), from the arch
 * curve and the units around them:
 * - a run of pontics between two units fills the span between their facing
 *   edges, split by the pontics' nominal template widths;
 * - a cantilever run starts at its unit's facing edge, one nominal width per
 *   pontic, shortened to the natural neighbour if the contact search finds
 *   one closer;
 * - occlusal = mean of the neighbouring units' occlusal directions (next to
 *   a front tooth, whose frame leans with its prep: their mean labial lean
 *   along the pontic's own labial direction), buccal = the curve's outward
 *   normal, mesial from FDI handedness; origin = the ridge under the centre
 *   (ray cast along −occlusal); a centre override replaces the arch position;
 * - contacts: the neighbouring units' facing edges (or the split points between
 *   pontics), and natural teeth on free sides.
 */
export function layoutPontics(input: { curve: ArchCurve; jaw: RayCaster; units: LayoutUnit[] }): PonticLayout[] {
  const { curve, jaw } = input;
  const units = [...input.units].sort((a, b) => archIndex(a.fdi) - archIndex(b.fdi));
  const extents = new Map<number, Extent>();
  for (const u of units) {
    if (u.kind === 'pontic') continue;
    const points: V3[] = [];
    if (u.outline && u.outline.length >= 3) {
      for (let i = 0; i < u.outline.length / 3; i++) points.push(pointAt(u.outline, i));
    } else if (u.frame) {
      const half = templateForTooth(u.fdi).size.md / 2;
      const s = curve.project(u.frame.origin);
      points.push(curve.pointAt(s - half), curve.pointAt(s + half));
    } else {
      throw new Error(`Unit ${u.fdi} has no frame or outline: place the abutment frames before the pontics`);
    }
    const e: Extent = { min: Infinity, max: -Infinity, minPoint: points[0]!, maxPoint: points[0]! };
    for (const p of points) {
      const s = curve.project(p);
      if (s < e.min) [e.min, e.minPoint] = [s, p];
      if (s > e.max) [e.max, e.maxPoint] = [s, p];
    }
    extents.set(u.fdi, e);
  }
  const firstKnown = units.find((u) => extents.has(u.fdi));
  if (!firstKnown) throw new Error('A bridge needs an abutment to place its pontics');
  // Arc length per arch-index step (+1 or −1), from FDI handedness at a known unit.
  const e0 = extents.get(firstKnown.fdi)!;
  const s0Known = (e0.min + e0.max) / 2;
  const growsMesial = dot(curve.mesialAt(s0Known, firstKnown.fdi), curve.tangentAt(s0Known)) > 0;
  const q0 = Math.floor(firstKnown.fdi / 10);
  const sign = growsMesial === (q0 === 1 || q0 === 4) ? 1 : -1;
  /** The facing edge of a known unit toward the higher (after) or lower arch index. */
  const edge = (e: Extent, after: boolean) => (after === sign > 0 ? { s: e.max, p: e.maxPoint } : { s: e.min, p: e.minPoint });
  const along = (s: number, after: boolean): V3 => scale(curve.tangentAt(s), after === sign > 0 ? 1 : -1);

  const layouts: PonticLayout[] = [];
  for (let i = 0; i < units.length; ) {
    if (units[i]!.kind !== 'pontic') {
      i++;
      continue;
    }
    let j = i;
    while (j < units.length && units[j]!.kind === 'pontic') j++;
    const run = units.slice(i, j);
    const before = i > 0 ? units[i - 1]! : undefined;
    const after = j < units.length ? units[j]! : undefined;
    i = j;
    const L = before && extents.get(before.fdi);
    const R = after && extents.get(after.fdi);
    const nominal = run.map((u) => templateForTooth(u.fdi).size.md);
    const total = nominal.reduce((a, b) => a + b, 0);
    const neighbours = [before, after].filter((u): u is LayoutUnit => Boolean(u?.frame));
    let occlusal: V3 = neighbours.length ? [0, 0, 0] : curve.occlusal;
    for (const u of neighbours) occlusal = add(occlusal, normalize(u.frame!.occlusal));
    occlusal = normalize(occlusal);
    // Front-tooth neighbours lean labially with their preps (estimateToothFrame). When they do (over 2°), a pontic
    // leans by their mean labial lean along its own labial direction (the curve's normal where it sits), not along a
    // neighbour's. Upright neighbours keep the mean occlusal.
    const lean = neighbours.some((u) => isFrontTooth(u.fdi)) ? meanLabialLean(curve, neighbours) : 0;
    const occlusalAt = (s: number): V3 =>
      Math.abs(lean) <= MIN_PONTIC_LEAN ? occlusal : normalize(add(scale(curve.occlusal, Math.cos(lean)), scale(curve.normalAt(s), Math.sin(lean))));
    const runWarnings: string[] = [];
    const label = run.map((u) => u.fdi).join(', ');

    let startS: number, endS: number;
    let startPoint: V3 | undefined, endPoint: V3 | undefined;
    let free: 'before' | 'after' | null = null;
    let frameCheck: string | undefined;
    if (L && R) {
      ({ s: startS, p: startPoint } = edge(L, true));
      ({ s: endS, p: endPoint } = edge(R, false));
      const gap = sign * (endS - startS);
      if (sign * ((R.min + R.max) / 2 - (L.min + L.max) / 2) <= 0) {
        frameCheck = `The frames of ${before!.fdi} and ${after!.fdi} are in the wrong order along the arch: check that each is on its own prep.`;
      } else if (gap > FRAME_SPAN_FACTOR * total) {
        frameCheck = `${before!.fdi} and ${after!.fdi} are ${gap.toFixed(0)} mm apart along the arch, but the pontics between them need about ${total.toFixed(0)} mm: check that each frame is on its own prep.`;
      }
    } else if (L) {
      ({ s: startS, p: startPoint } = edge(L, true));
      endS = startS + sign * total;
      free = 'after';
    } else if (R) {
      ({ s: endS, p: endPoint } = edge(R, false));
      startS = endS - sign * total;
      free = 'before';
    } else {
      throw new Error(`Pontics ${label} are not next to an abutment`);
    }

    // Cantilever: a natural tooth closer than the nominal widths ends the run at its contact.
    let naturalContact: V3 | undefined;
    if (free) {
      const outward = free === 'after';
      const from = outward ? startS + sign * 0.5 : endS - sign * 0.5;
      const dir = along(from, outward);
      const origin = curve.pointAt(from);
      const occlusalFrom = occlusalAt(from);
      const buccal = normalize(reject(curve.normalAt(from), occlusalFrom));
      const found = findNeighbourContacts({ origin, occlusal: occlusalFrom, mesial: dir, buccal, ray: jaw, maxDistanceMm: total * 1.3 + 2 }).mesial;
      if (found) {
        const s = curve.project(found.point);
        const reach = outward ? sign * (s - startS) : sign * (endS - s);
        if (reach > 0 && reach < total) {
          naturalContact = found.point;
          if (outward) endS = s;
          else startS = s;
        }
      }
    }
    const width = Math.abs(endS - startS);
    if (width < 0.5 * total) runWarnings.push(`Little room for pontic ${label}: ${width.toFixed(1)} mm along the arch (nominal ${total.toFixed(1)} mm).`);

    let cum = 0;
    run.forEach((u, k) => {
      const a = startS + ((endS - startS) * cum) / total;
      cum += nominal[k]!;
      const b = startS + ((endS - startS) * cum) / total;
      const warnings = [...runWarnings];
      let s = (a + b) / 2;
      let above = curve.pointAt(s);
      if (u.centre) {
        s = curve.project(u.centre);
        above = u.centre;
      }
      const occlusal = occlusalAt(s);
      const buccal = normalize(reject(curve.normalAt(s), occlusal));
      const mesial = mesialFromBuccal(u.fdi, occlusal, buccal);
      const ridge = jaw.first(add(above, scale(occlusal, 10)), scale(occlusal, -1), 40);
      if (!ridge) warnings.push(`No ridge found under pontic ${u.fdi}; its frame origin is on the arch curve.`);
      const contacts: Partial<Record<ProximalSide, V3>> = {};
      const beforeContact = k > 0 ? curve.pointAt(a) : startPoint ?? (free === 'before' ? naturalContact : undefined);
      const afterContact = k < run.length - 1 ? curve.pointAt(b) : endPoint ?? (free === 'after' ? naturalContact : undefined);
      if (beforeContact) contacts[sideToward(u.fdi, false)] = beforeContact;
      if (afterContact) contacts[sideToward(u.fdi, true)] = afterContact;
      layouts.push({
        fdi: u.fdi,
        frame: {
          origin: ridge ? ridge.point : above,
          occlusal,
          mesial,
          buccal,
          ...(contacts.mesial ? { mesialContact: contacts.mesial } : {}),
          ...(contacts.distal ? { distalContact: contacts.distal } : {}),
        },
        s,
        span: [a, b],
        mdMm: Math.abs(b - a),
        cantilever: free !== null,
        warnings,
        ...(frameCheck ? { frameCheck } : {}),
      });
    });
  }
  return layouts;
}

/** Below this mean labial lean of the neighbours (rad), a pontic keeps their mean occlusal direction. */
const MIN_PONTIC_LEAN = (2 * Math.PI) / 180;

/** The mean labial lean (rad) of units' occlusal directions: from the curve's occlusal toward its normal where each sits. */
function meanLabialLean(curve: ArchCurve, units: readonly LayoutUnit[]): number {
  let sum = 0;
  for (const u of units) {
    const o = normalize(u.frame!.occlusal);
    sum += Math.atan2(dot(o, curve.normalAt(curve.project(u.frame!.origin))), dot(o, curve.occlusal));
  }
  return sum / units.length;
}

/**
 * An abutment frame with its mesial-distal line from the arch curve: the
 * occlusal direction and origin are kept, buccal = the curve's outward normal
 * at the origin, mesial by FDI handedness, and the neighbour contacts are
 * searched again along the new axes. A click-based estimate
 * (estimateToothFrame) reads the mesial-distal line from the crowns around
 * the prep, which a neighbouring gap leaves ambiguous: next to an edentulous
 * span it can be off by 90°. `changeDeg` is the angle between the old and
 * new mesial directions.
 */
export function archAlignedFrame(input: { frame: CrownFrame; fdi: number; curve: ArchCurve; ray: RayCaster }): { frame: CrownFrame; changeDeg: number } {
  const { frame, fdi, curve, ray } = input;
  const occlusal = normalize(frame.occlusal);
  const buccal = normalize(reject(curve.normalAt(curve.project(frame.origin)), occlusal));
  const mesial = mesialFromBuccal(fdi, occlusal, buccal);
  const contacts = findNeighbourContacts({ origin: frame.origin, occlusal, mesial, buccal, ray });
  return {
    frame: {
      origin: frame.origin,
      occlusal,
      mesial,
      buccal,
      ...(contacts.mesial ? { mesialContact: contacts.mesial.point } : {}),
      ...(contacts.distal ? { distalContact: contacts.distal.point } : {}),
    },
    changeDeg: (Math.acos(Math.min(1, Math.max(-1, dot(mesial, normalize(frame.mesial))))) * 180) / Math.PI,
  };
}

// ---- Bridge design ---------------------------------------------------------------

/** Connectors of an inlay or onlay retainer (spec): in the proximal box, at least 0.5 mm above its floor, 3 × 3 mm. */
export const INLAY_BRIDGE_CONNECTOR = { boxFloorClearanceMm: 0.5, minWidthMm: 3 } as const;

export interface BridgeUnitInput {
  fdi: number;
  /** The unit's role (RESTORATION_ROLE[type].role); designBridge dispatches on it. */
  kind: UnitKind;
  params: DesignParams;
  /**
   * Abutments: the tooth frame (required). Pontics: optional, omitted = layoutPontics on the retainer shells. A stored
   * pontic frame gives the axes; a proposed pose is still centred by the layout on the retainer shells.
   */
  frame?: CrownFrame;
  /** Abutments: dense margin, xyz packed, and its prep region. */
  margin?: Float32Array;
  region?: CrownInput['region'];
  /** Stored template pose; omitted = proposed (BridgeUnitResult.proposed). */
  pose?: Pose;
  /** Adaptation targets; sides facing a connected unit are dropped (they have a connector, not a contact). */
  adapt?: CrownAdapt;
  /** Pontics: centre override (a click on the ridge); places the proposed pose, also when a frame is stored. */
  centre?: V3;
  template?: CrownTemplate;
  /** Abutments: a Maryland wing on the outline region (designWingUnit) instead of a crown; it has no pose. */
  wing?: boolean;
  /**
   * Abutments: an inlay or onlay in the cavity inside the margin (designInlayUnit) instead of a crown. The pre-op
   * source has no pose; the library source's pose is the fitted (or moved) library tooth. `preopKey` identifies the
   * pre-op scan in the cache key.
   */
  inlay?: { type: InlayType; source: OuterSource; preop?: PreopScan; preopKey?: string };
  /** Implant crowns (abutments): the Ti-base, the scan-body pose and the screw channel, instead of a margin. */
  implant?: ImplantUnit;
  /** Reduced units: the cutback; the framework joins the connectors and the union (framework.ts). */
  cutback?: Cutback;
}

export interface BridgeInput {
  /** The jaw scan with the preps and the ridge. */
  jaw: CrownInput['jaw'];
  antagonist?: RayCaster;
  /** The bridge's common insertion axis (searchCommonAxis). */
  axis: V3;
  /** The bridge's units, in arch order (BridgeDesign.teeth). */
  units: BridgeUnitInput[];
  /** Its connectors (BridgeDesign.connectors). */
  connectors: ConnectorDesign[];
  material: Material;
  /** The jaw's arch curve (fit once per scan); omitted = fitted here from the abutment frames. */
  curve?: ArchCurve;
  maps?: CrownMapName[];
  /** Merge into one solid and run the bridge checks (await initMeshBoolean() first). */
  union?: boolean;
  /** Reuse unit and connector results across calls (moving one unit recomputes it and its connectors only). */
  cache?: BridgeCache;
  /** Identity of the scans, part of every cache key (e.g. the jaw and antagonist sha256). */
  scanKey?: string;
}

export interface BridgeUnitResult {
  fdi: number;
  kind: UnitKind;
  /** Same shape as a single crown; a pontic adds `base` (its gap to the ridge), a Maryland wing `wing`. */
  design: CrownDesign & { base?: PonticBaseGap; wing?: WingUnitReport; inlay?: InlayUnitReport; inlayPatch?: FittingPatch };
  /** The frame it was designed in: an abutment's without contacts toward connected units, or the pontic frame. */
  frame: CrownFrame;
  /** True when no pose was given: design.pose is a proposal (the app stores it with setCrown, one batch per bridge). */
  proposed: boolean;
  /** Pontics: the layout on the arch curve (span, width, cantilever). */
  layout?: PonticLayout;
  /** Proximal sides with a connector. */
  connectedSides: ProximalSide[];
  cached: boolean;
  ms: number;
  /** Reduced units: the framework (the design keeps the anatomy). */
  framework?: UnitFramework;
}

export interface BridgeConnectorResult extends ConnectorGeometry {
  /** The stored settings it was built from. */
  settings: ConnectorDesign;
  /** The material minimum (minConnectorAreaMm2; next to a wing, the Maryland minimum) and minimum height (BRIDGE_PRESETS). */
  minAreaMm2: number;
  minHeightMm: number;
  cached: boolean;
}

export interface BridgeResult {
  units: BridgeUnitResult[];
  connectors: BridgeConnectorResult[];
  /** With `union: true`: the merged solid and the checks measured on it. */
  union?: { mesh: IndexedMesh; checks: BridgeChecks };
  /** With `union: true`, when the boolean engine refused the inputs: why (there is then no `union`). */
  unionError?: string;
  /** With `union: true`: the overpress of each reduced unit with `cutback.overpress` (framework.ts). */
  overpress?: UnitOverpress[];
  curve: { kind: ArchCurve['kind']; lengthMm: number; midlineS: number | null; rmsMm: number };
  warnings: string[];
  timingsMs: Record<string, number>;
}

/** A designed unit plus what its connectors need (ray casters, width). Kept in the cache. */
export interface UnitWork {
  result: BridgeUnitResult;
  key: string;
  /** Ray caster over the whole unit mesh. */
  solid: RayCaster;
  /** Its fitting surface (intaglio or base). */
  inner: IntaglioSurface;
  blMm: number;
}

/** LRU cache of unit and connector results, keyed by a hash of their inputs. */
export class BridgeCache {
  private readonly entries = new Map<string, unknown>();
  constructor(readonly maxEntries = 96) {}

  get<T>(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value as T;
  }

  set(key: string, value: unknown): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Two 32-bit FNV-1a-style hashes (64 bits) over the inputs: typed arrays by their bytes, everything else by its JSON. */
function hashInputs(parts: unknown[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  const byte = (b: number) => {
    h1 = Math.imul(h1 ^ b, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x01000193 + 0x2f) >>> 0;
  };
  const visit = (x: unknown) => {
    if (ArrayBuffer.isView(x)) {
      const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      for (let i = 0; i < bytes.length; i++) byte(bytes[i]!);
      byte(0xff);
      return;
    }
    const s = JSON.stringify(x) ?? 'undefined';
    for (let i = 0; i < s.length; i++) byte(s.charCodeAt(i) & 0xff);
    byte(0xfe);
  };
  for (const p of parts) visit(p);
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** The frame without the contacts on the given sides. */
function dropContacts(frame: CrownFrame, sides: ProximalSide[]): CrownFrame {
  const { mesialContact, distalContact, ...rest } = frame;
  return {
    ...rest,
    ...(mesialContact && !sides.includes('mesial') ? { mesialContact } : {}),
    ...(distalContact && !sides.includes('distal') ? { distalContact } : {}),
  };
}

/** Adaptation targets without the connected sides. */
function dropAdaptSides(adapt: CrownAdapt | undefined, sides: ProximalSide[]): CrownAdapt | undefined {
  if (!adapt) return undefined;
  const out: CrownAdapt = { ...adapt };
  for (const side of sides) delete out[side];
  return out;
}

/**
 * A unit's fitting surface: the triangles whose corners are all among the first `count` vertices (the intaglio or
 * the pontic base), with a ray caster and its BVH-ordered index (for signed distances).
 */
function innerSurface(mesh: IndexedMesh, count: number): IntaglioSurface {
  const tris: number[] = [];
  const idx = mesh.indices;
  for (let f = 0; f < idx.length; f += 3) {
    if (idx[f]! < count && idx[f + 1]! < count && idx[f + 2]! < count) tris.push(idx[f]!, idx[f + 1]!, idx[f + 2]!);
  }
  const positions = mesh.positions.slice(0, count * 3);
  const indices = Uint32Array.from(tris); // reordered in place by the BVH build; canonical afterwards
  return { ray: bvhRayCaster(createBvh({ positions, indices })), positions, indices };
}

const solidOf = (mesh: IndexedMesh): RayCaster => bvhRayCaster(createBvh({ positions: mesh.positions.slice(), indices: mesh.indices.slice() }));

/** The outer-shell vertices of a designed unit, xyz packed (its outline for the pontic layout). */
const shellOf = (design: CrownDesign): Float32Array => design.mesh.positions.subarray(design.shellStart * 3);

/**
 * Design one bridge: retainers (designCrown on the common axis, contacts and
 * adaptation only on free sides), pontics (layoutPontics on the retainer
 * shells, then designPontic), connectors (designConnector) and, with
 * `union`, the merged solid and its checks. Pure geometry: used by the
 * geometry worker and the pipeline runner.
 */
export function designBridge(input: BridgeInput): BridgeResult {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = (timings[name] ?? 0) + now - t;
    t = now;
  };
  const { jaw, antagonist, cache, material } = input;
  const axis = normalize(input.axis);
  const warnings: string[] = [];
  const units = [...input.units].sort((a, b) => archIndex(a.fdi) - archIndex(b.fdi));
  // Same rule as connectedSides(doc, fdi): a side facing a connected unit has a connector, not a contact.
  const sidesOf = (fdi: number): ProximalSide[] =>
    input.connectors.filter((c) => c.between.includes(fdi)).map(({ between: [a, b] }) => facingSide(fdi, a === fdi ? b : a));
  const abutments = units.filter((u) => u.kind === 'abutment');
  if (abutments.length === 0) throw new Error('A bridge needs at least one abutment');
  const common = [input.scanKey ?? '', Boolean(antagonist), axis, input.maps ?? []];

  // Arch curve: fit once per scan (callers pass it in); here from the abutment frames.
  const curve = input.curve ?? fitArchCurve({ positions: jaw.positions, ...archFitDirections(abutments.flatMap((u) => (u.frame ? [{ ...u.frame, fdi: u.fdi }] : [])), jaw.positions) });
  lap('curve');

  const work = new Map<number, UnitWork>();
  // Implant crowns take their widths from the implant spacing along the arch (implantBridge.ts).
  const widths = implantUnitWidths(curve, units.map((u) => ({ fdi: u.fdi, kind: u.kind, ...(u.implant ? { implantCentre: implantToWorld(u.implant.pose)([0, 0, u.implant.entry.tiBaseTopZ]) } : {}) })));
  /**
   * A unit from the cache or freshly designed. Units are keyed by their resolved pose, so storing a proposal (setCrown)
   * is a cache hit, and moving one unit misses only for it. Proposal warnings are added per call, never cached.
   */
  const unit = (
    u: BridgeUnitInput,
    keyParts: unknown[],
    frame: CrownFrame,
    proposal: { pose: Pose; warnings: string[] } | null,
    design: () => BridgeUnitResult['design'],
    layout?: PonticLayout,
  ): UnitWork => {
    const key = hashInputs(keyParts);
    let w = cache?.get<UnitWork>(key);
    const cached = Boolean(w);
    if (!w) {
      const t0 = performance.now();
      const d = design();
      const template = u.template ?? templateForTooth(u.fdi);
      w = {
        result: { fdi: u.fdi, kind: u.kind, design: d, frame, proposed: false, connectedSides: sidesOf(u.fdi), cached: false, ms: performance.now() - t0 },
        key,
        solid: solidOf(d.mesh),
        // An inlay's boundary vertices are among its first vertices, so faces of its outer surface can have all corners
        // there: its fitting surface is the first fittingFaces faces instead.
        inner: d.inlay ? fittingSurfaceOf(d.mesh, d.intaglioVertices, d.inlay.fittingFaces) : innerSurface(d.mesh, d.intaglioVertices),
        blMm: Math.abs(d.pose.scale[1]) * template.size.bl,
      };
      cache?.set(key, w);
    }
    const design0 = w.result.design;
    return {
      ...w,
      result: {
        ...w.result,
        design: proposal?.warnings.length ? { ...design0, warnings: [...proposal.warnings, ...design0.warnings] } : design0,
        proposed: Boolean(proposal),
        // Bridge context, not geometry: never taken from the cache.
        connectedSides: sidesOf(u.fdi),
        ...(layout ? { layout } : {}),
        cached,
        ms: cached ? 0 : w.result.ms,
      },
    };
  };

  // 1. Retainers.
  for (const u of abutments) {
    if (u.implant && u.frame) {
      const r = implantRetainer({ ...u, implant: u.implant, frame: u.frame, sides: sidesOf(u.fdi), jaw, antagonist, axis, widths, maps: input.maps });
      work.set(u.fdi, unit(u, ['implant', ...common, ...r.key], r.frame, r.proposal, r.design));
      continue;
    }
    if (!u.frame || !u.margin || !u.region) throw new Error(`Abutment ${u.fdi} needs a frame and a margin`);
    const sides = sidesOf(u.fdi);
    const frame = dropContacts(u.frame, sides);
    if (u.wing) {
      // A Maryland wing follows from its outline, the axis and its parameters: there is no pose to propose.
      const region = u.region;
      const keyParts = ['wing', ...common, u.fdi, u.params, frame, u.margin];
      const design = () => {
        const d = designWingUnit({ jaw, antagonist, region, axis, params: u.params, maps: input.maps });
        // Its centre (the end of the connector lines) is the natural tooth's: on the arch curve, in the middle of the wing's extent along it.
        let lo = Infinity, hi = -Infinity;
        for (let v = d.shellStart; v < d.mesh.positions.length / 3; v++) {
          const s = curve.project(pointAt(d.mesh.positions, v));
          lo = Math.min(lo, s);
          hi = Math.max(hi, s);
        }
        return { ...d, pose: { ...d.pose, position: curve.pointAt((lo + hi) / 2) } };
      };
      work.set(u.fdi, unit(u, keyParts, frame, u.pose ? null : { pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, warnings: [] }, design));
      continue;
    }
    if (u.inlay) {
      // An inlay or onlay restores its cavity; the pre-op source has no pose, the library source proposes the fitted one.
      const { type, source, preop, preopKey } = u.inlay;
      const region = u.region;
      const pose = source === 'library' ? u.pose : undefined;
      const keyParts = ['inlay', ...common, u.fdi, u.params, frame, u.margin, type, source, preopKey ?? '', pose ?? null, u.template?.id ?? null];
      const margin = u.margin;
      const design = () =>
        designInlayUnit({ fdi: u.fdi, type, role: 'retainer', jaw, antagonist, region, margin, axis, params: u.params, frame, source, preop, pose, template: u.template, maps: input.maps });
      work.set(u.fdi, unit(u, keyParts, frame, u.pose ? null : { pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, warnings: [] }, design));
      continue;
    }
    const adapt = dropAdaptSides(u.adapt, sides);
    const crown = { fdi: u.fdi, jaw, antagonist, region: u.region, frame, margin: u.margin, axis, params: u.params, template: u.template, maps: input.maps, adapt };
    const proposal = u.pose ? null : proposeCrownPoseFor(crown);
    const pose = u.pose ?? proposal!.pose;
    const keyParts = ['abutment', ...common, u.fdi, u.params, frame, u.margin, pose, adapt ?? null, u.template?.id ?? null];
    work.set(u.fdi, unit(u, keyParts, frame, proposal, () => designCrown({ ...crown, pose })));
  }
  lap('retainers');

  // 2. Pontics: laid out on the retainer shells, sized to the gap between them.
  const pontics = units.filter((u) => u.kind === 'pontic');
  if (pontics.length > 0) {
    const layouts = layoutPontics({
      curve,
      jaw: jaw.ray,
      units: units.map((u) => {
        const w = work.get(u.fdi);
        return w ? { fdi: u.fdi, kind: u.kind, frame: w.result.frame, outline: shellOf(w.result.design) } : { fdi: u.fdi, kind: u.kind, centre: u.centre };
      }),
    });
    lap('layout');
    for (const u of pontics) {
      const layout = layouts.find((l) => l.fdi === u.fdi)!;
      warnings.push(...layout.warnings);
      const frame = u.frame ?? layout.frame;
      // Contacts only on free sides that have a natural neighbour (a cantilever's outer side may have none).
      const sides = sidesOf(u.fdi);
      if (!frame.mesialContact) sides.push('mesial');
      if (!frame.distalContact) sides.push('distal');
      const adapt = dropAdaptSides(u.adapt, sides);
      let proposal: { pose: Pose; warnings: string[] } | null = null;
      if (!u.pose) {
        // The nearest retainers on either side give the bucco-lingual ratio (pontics are skipped, designed or not).
        const index = units.indexOf(u);
        const ratios: number[] = [];
        for (const dir of [-1, 1]) {
          for (let k = index + dir; k >= 0 && k < units.length; k += dir) {
            if (units[k]!.kind === 'pontic') continue;
            const w = work.get(units[k]!.fdi);
            if (w) {
              ratios.push(Math.abs(w.result.design.pose.scale[1]));
              break;
            }
          }
        }
        proposal = proposePonticPose({
          template: u.template ?? templateForTooth(u.fdi),
          // Centred in the span its width comes from: the layout on the retainer shells (a stored frame may come from
          // the layout on the margins, before the crowns existed). Its axes stay the stored frame's.
          frame: { ...frame, origin: layout.frame.origin },
          ridgeGapMm: u.params.ponticRidgeGapMm,
          spanMm: layout.mdMm,
          blRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1,
          antagonist,
          params: u.params,
        });
      }
      const pose = u.pose ?? proposal!.pose;
      const keyParts = ['pontic', ...common, u.fdi, u.params, frame, pose, adapt ?? null, u.template?.id ?? null];
      const design = () =>
        designPontic({ fdi: u.fdi, jaw, antagonist, frame, axis, params: u.params, pose, template: u.template, maps: input.maps, adapt });
      work.set(u.fdi, unit(u, keyParts, frame, proposal, design, layout));
    }
    lap('pontics');
    // Inlay-retained bridges: the edentulous gap (the widths the arch gives the pontics) is at most 12 mm.
    if (units.some((u) => u.inlay)) warnings.push(...inlayBridgeIndications({ gapMm: layouts.reduce((sum, l) => sum + l.mdMm, 0), retainers: [] }));
  }
  // Reduced units: the connectors and the union use their frameworks.
  applyFrameworks(work, units, cache, warnings);
  lap('frameworks');

  // 3. Connectors.
  const minHeightMm = BRIDGE_PRESETS[material].connectorMinHeightMm;
  const connectors: BridgeConnectorResult[] = [];
  for (const settings of input.connectors) {
    const [fa, fb] = settings.between;
    const wa = work.get(fa), wb = work.get(fb);
    if (!wa || !wb) throw new Error(`Connector ${fa}–${fb}: both units must be in the bridge`);
    // Next to a Maryland wing the minimum is 3 mm × 2 mm (MARYLAND_CONNECTOR) instead of the material's area.
    const maryland = Boolean(wa.result.design.wing || wb.result.design.wing);
    const minAreaMm2 = maryland ? MARYLAND_CONNECTOR_MIN_AREA_MM2 : minConnectorAreaMm2(material, fa, fb);
    if (settings.areaMm2 < minAreaMm2) warnings.push(`Connector ${fa}–${fb}: ${settings.areaMm2} mm² is below the ${maryland ? 'Maryland' : material} minimum of ${minAreaMm2} mm².`);
    const key = hashInputs(['connector', ...common, wa.key, wb.key, settings, minHeightMm]);
    const hit = cache?.get<ConnectorGeometry>(key);
    let geometry = hit;
    if (!geometry) {
      const unitOf = (w: UnitWork): ConnectorUnit => {
        const wing = w.result.design.wing;
        return {
          fdi: w.result.fdi,
          mesh: assemblyMesh(w.result),
          shellStart: w.result.design.shellStart,
          solid: w.solid,
          inner: w.inner,
          centre: w.result.design.pose.position,
          buccal: w.result.frame.buccal,
          blMm: w.blMm,
          // The end sinks only into the wing, never deeper than its thickness − 0.2 mm, and must clear the tooth.
          ...(wing ? { wing: { maxSinkMm: Math.max(0, wing.params.wingThicknessMm - 0.2), cementGapMm: wing.params.cementGapMm } } : {}),
          // An inlay: the connector sits in the proximal box, above its floor, and is at least 3 mm wide.
          ...(w.result.design.inlay ? { inlay: INLAY_BRIDGE_CONNECTOR } : {}),
        };
      };
      geometry = designConnector({
        between: [fa, fb],
        a: unitOf(wa),
        b: unitOf(wb),
        axis,
        areaMm2: settings.areaMm2,
        buccalMm: settings.buccalMm,
        occlusalMm: settings.occlusalMm,
        minHeightMm,
        jaw: jaw.ray,
      });
      cache?.set(key, geometry);
    }
    warnings.push(...geometry.warnings, ...geometry.failures.map((f) => f.message));
    connectors.push({ ...geometry, settings, minAreaMm2, minHeightMm, cached: Boolean(hit) });
  }
  lap('connectors');

  const unitResults = units.map((u) => work.get(u.fdi)!.result);
  for (const r of unitResults) warnings.push(...r.design.warnings.map((w) => `${r.fdi}: ${w}`));

  // 4. Union and checks. A union the engine refuses is reported (unionError), not thrown: nothing is exported then.
  let union: BridgeResult['union'];
  let unionError: string | undefined;
  let overpress: UnitOverpress[] | undefined;
  if (input.union) {
    if (!meshBooleanReady()) throw new Error('Mesh booleans are not initialized: await initMeshBoolean() before a bridge union');
    let mesh: IndexedMesh | undefined;
    try {
      mesh = unionMeshes([...unitResults.map((r) => (r.framework ? assemblyMesh(r) : unionMeshOf(r.design))), ...connectors.map((c) => c.mesh)]);
    } catch (error) {
      unionError = `The bridge could not be merged into one solid: ${(error as Error).message}`;
      warnings.push(unionError);
    }
    lap('union');
    if (mesh) {
      const checks = checkBridgeUnion({
        union: mesh,
        jaw,
        axis,
        units: units.map((u) => ({ input: u, result: work.get(u.fdi)!.result })),
        connectors,
        expectedGenus: channelCount(unitResults.map((r) => r.design)),
      });
      warnings.push(...checks.failures.filter((f) => !warnings.includes(f)));
      union = { mesh, checks };
      lap('checks');
      overpress = bridgeOverpress(unitResults, connectors.map((c) => c.mesh), warnings);
      lap('overpress');
    }
  }

  return {
    units: unitResults,
    connectors,
    ...(union ? { union } : {}),
    ...(unionError ? { unionError } : {}),
    ...(overpress?.length ? { overpress } : {}),
    curve: { kind: curve.kind, lengthMm: curve.lengthMm, midlineS: curve.midlineS, rmsMm: curve.rmsMm },
    warnings,
    timingsMs: timings,
  };
}
