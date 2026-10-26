import { isPosterior, type CrownAdapt, type DesignParams, type Pose } from '@dcad/shared';
import { crownAxes, fitAndFinishShell, placeShell, poseRotation, type CrownDesign, type CrownFrame } from './crown';
import type { CrownMapName } from './crownMaps';
import { templateForTooth, type CrownTemplate } from './crownTemplate';
import { implantBasis, implantToWorld, worldToImplant, type ImplantLibraryEntry, type ImplantPose } from './implantLibrary';
import { planeBasis } from './intaglio';
import type { IndexedMesh } from './mesh';
import { differenceMeshes, meshBooleanReady } from './meshBoolean';
import { meshTopology, validateClosedMesh } from './meshValidate';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import { countSelfIntersections } from './selfIntersect';
import { tiBaseFittingSurface, type TiBaseGapCheck } from './tiBase';
import { findNeighbourContacts } from './toothFrame';

/**
 * Implant crowns, screw-retained on a library Ti-base (specs/2026-10-25-implant-bridges.md). The same pipeline as a
 * crown (crown.ts placeShell → fitAndFinishShell), with the implant's fitting side:
 * - inner surface: the Ti-base at the implant pose, offset by the bonding gap (tiBase.ts), with the shoulder loop
 *   as the rim: the restoration ends flush with the Ti-base collar (a minimal band, not the margin thickness). Rim
 *   points hidden under the Ti-base from the insertion path (a bridge's common path on divergent implants) mean the
 *   restoration cannot be seated: they are counted and reported;
 * - anatomy: the library tooth posed as for crowns, with its cervical ring on the gingival opening (where the
 *   gingiva meets the scan body), raised or lowered per azimuth to follow it;
 * - emergence: per template column, a Hermite curve from the Ti-base shoulder up to the ring, continuous with the
 *   template wall at the top; `emergenceConcavity` (0 straight … 1 concave) sets the start tangent at the shoulder;
 * - screw channel: a cylinder of the library's diameter from the screw-head pivot along the implant axis, or tilted
 *   up to the library's ASC maximum, with exit and wall checks, subtracted from the restoration (manifold-3d).
 * The returned `mesh` is the restoration without the channel (display, maps, connectors, move previews keep the
 * crown's vertex layout); `implant.cut` is the restoration with it (export, the bridge union).
 */

export const DEFAULT_CHANNEL_WALL_MM = 0.8;
export const DEFAULT_EMERGENCE_CONCAVITY = 0.5;
/** Posterior units: the channel must exit where the outer normal · occlusal exceeds this. */
export const CHANNEL_EXIT_OCCLUSAL_MIN = 0.5;
/** Anterior units: the channel must exit where the outer normal · lingual exceeds this. */
export const CHANNEL_EXIT_LINGUAL_MIN = 0.3;
/** Scan points this close to the registered scan body belong to it (gingival opening, ignored neighbour faces). */
const SCAN_BODY_TOLERANCE_MM = 0.3;
/** Azimuth bins of the gingival opening. */
const OPENING_BINS = 48;
/** Neighbour contacts are searched this high above the gingival opening (about a crown's height of contour). */
const CONTACT_HEIGHT_MM = 4;
/** The ring never comes closer to the shoulder than this along the implant axis. */
const MIN_EMERGENCE_HEIGHT_MM = 0.4;
/** The ring stays at least this far outside the Ti-base collar (radially). */
const MIN_EMERGENCE_FLARE_MM = 0.3;
/** Height of one emergence row (mm along the profile). */
const EMERGENCE_STEP_MM = 0.35;
/** The band between the rim and the emergence: the restoration ends flush with the Ti-base collar. */
const IMPLANT_BAND_MM = 0.02;
const MIN_HEIGHT_MM = 4;
const MAX_HEIGHT_SCALE = 1.3;
const CHANNEL_SEGMENTS = 48;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const reject = (a: V3, n: V3): V3 => sub(a, scale(n, dot(a, n)));
const pointAt = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
const DEG = Math.PI / 180;

/** An implant unit: its library entry, the registered pose and the screw channel (omitted = straight). */
export interface ImplantUnit {
  entry: ImplantLibraryEntry;
  pose: ImplantPose;
  channel?: { angleDeg: number; azimuthDeg: number };
}

// ---- Gingival opening ----------------------------------------------------------------

export interface GingivalOpening {
  /** Where the gingiva meets the scan body, one point per azimuth bin, CCW about the implant axis. */
  loop: Float32Array;
  /** Height of the loop above the platform (library z) per bin. */
  heights: Float32Array;
  /** On the implant axis at the mean height. */
  centre: V3;
  meanHeightMm: number;
  minHeightMm: number;
  maxHeightMm: number;
  /** Share of the bins with scan points (the others are interpolated). */
  coverage: number;
}

const scanBodyRays = new WeakMap<IndexedMesh, RayCaster>();
function scanBodyRay(entry: ImplantLibraryEntry): RayCaster {
  let ray = scanBodyRays.get(entry.scanBody);
  if (!ray) {
    ray = bvhRayCaster(createBvh({ positions: entry.scanBody.positions, indices: entry.scanBody.indices.slice() }));
    scanBodyRays.set(entry.scanBody, ray);
  }
  return ray;
}

/** Scan vertices within the scan-body tolerance of the registered scan body (local coordinates, library frame). */
function scanBodyVertices(positions: Float32Array, entry: ImplantLibraryEntry, pose: ImplantPose): { ids: number[]; local: V3[] } {
  const toLocal = worldToImplant(pose);
  const ray = scanBodyRay(entry);
  const reach = entry.scanBodyRadiusMm + 1;
  const ids: number[] = [];
  const local: V3[] = [];
  for (let v = 0; v < positions.length / 3; v++) {
    const q = toLocal(pointAt(positions, v));
    if (q[2] < -3 || q[2] > entry.scanBodyTopZ + 1 || Math.hypot(q[0], q[1]) > reach) continue;
    if (!ray.closestPoint(q, SCAN_BODY_TOLERANCE_MM)) continue;
    ids.push(v);
    local.push(q);
  }
  return { ids, local };
}

/**
 * The gingival opening: per azimuth bin around the implant axis, the lowest scan point within 0.3 mm of the
 * registered scan body (where the gingiva meets it). Empty bins are interpolated around the loop.
 */
export function gingivalOpening(input: { positions: Float32Array; entry: ImplantLibraryEntry; pose: ImplantPose }): GingivalOpening {
  const { entry, pose } = input;
  const { local } = scanBodyVertices(input.positions, entry, pose);
  const best: Array<V3 | null> = Array.from({ length: OPENING_BINS }, () => null);
  for (const q of local) {
    const bin = Math.floor(((Math.atan2(q[1], q[0]) + 2 * Math.PI) % (2 * Math.PI)) / ((2 * Math.PI) / OPENING_BINS)) % OPENING_BINS;
    if (!best[bin] || q[2] < best[bin]![2]) best[bin] = q;
  }
  const filled = best.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  if (filled.length === 0) throw new Error('The scan body does not meet the gingiva in the scan (no scan points on it)');
  const points: V3[] = best.map((b, i) => {
    if (b) return b;
    // Interpolate (polar, in the library frame) between the nearest filled bins on either side.
    let lo = i, hi = i, dl = 0, dh = 0;
    while (!best[lo]) [lo, dl] = [(lo - 1 + OPENING_BINS) % OPENING_BINS, dl + 1];
    while (!best[hi]) [hi, dh] = [(hi + 1) % OPENING_BINS, dh + 1];
    const a = best[lo]!, c = best[hi]!;
    const t = dl / (dl + dh);
    const r = (1 - t) * Math.hypot(a[0], a[1]) + t * Math.hypot(c[0], c[1]);
    const phi = ((i + 0.5) * 2 * Math.PI) / OPENING_BINS;
    return [r * Math.cos(phi), r * Math.sin(phi), (1 - t) * a[2] + t * c[2]];
  });
  // Light smoothing of the heights (the scan's triangles cross the junction at random heights).
  const heights = new Float32Array(OPENING_BINS);
  for (let i = 0; i < OPENING_BINS; i++) {
    heights[i] = (points[(i - 1 + OPENING_BINS) % OPENING_BINS]![2] + 2 * points[i]![2] + points[(i + 1) % OPENING_BINS]![2]) / 4;
  }
  const toWorld = implantToWorld(pose);
  const loop = new Float32Array(OPENING_BINS * 3);
  points.forEach((p, i) => loop.set(toWorld([p[0], p[1], heights[i]!]), i * 3));
  let mean = 0, min = Infinity, max = -Infinity;
  for (const h of heights) {
    mean += h / OPENING_BINS;
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  return { loop, heights, centre: toWorld([0, 0, mean]), meanHeightMm: mean, minHeightMm: min, maxHeightMm: max, coverage: filled.length / OPENING_BINS };
}

/** Opening height (library z) at a library-frame azimuth, interpolated between bins. */
function openingHeightAt(opening: GingivalOpening, phi: number): number {
  const x = (((phi + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * OPENING_BINS - 0.5;
  const i0 = Math.floor(x);
  const t = x - i0;
  const h = (i: number) => opening.heights[((i % OPENING_BINS) + OPENING_BINS) % OPENING_BINS]!;
  return (1 - t) * h(i0) + t * h(i0 + 1);
}

/**
 * The tooth frame of an implant unit: the clicked frame's axes, with its origin moved to the gingival opening centre
 * and the neighbour contacts searched again from there (CONTACT_HEIGHT_MM up). Scan-body faces seen from inside are
 * back-facing, so the contact search passes through them.
 */
export function implantToothFrame(input: { frame: CrownFrame; opening: GingivalOpening; ray: RayCaster }): CrownFrame {
  const { frame, opening, ray } = input;
  const occlusal = normalize(frame.occlusal);
  const contacts = findNeighbourContacts({ origin: add(opening.centre, scale(occlusal, CONTACT_HEIGHT_MM)), occlusal, mesial: frame.mesial, buccal: frame.buccal, ray });
  return {
    origin: opening.centre,
    occlusal,
    mesial: frame.mesial,
    buccal: frame.buccal,
    ...(contacts.mesial ? { mesialContact: contacts.mesial.point } : {}),
    ...(contacts.distal ? { distalContact: contacts.distal.point } : {}),
  };
}

// ---- Pose ------------------------------------------------------------------------------------

/**
 * Initial template pose: the cervix centred on the gingival opening, in the tooth frame. Mesio-distal width:
 * `mdMm` (a bridge gives it from the implant spacing), else the gap between the neighbour contacts, else twice the
 * distance from one contact to the implant, else the template's; bucco-lingual: the template's, scaled with the
 * width (0.85–1.15); height: up to the antagonist minus the occlusal clearance (the template's without one).
 */
export function proposeImplantCrownPose(input: {
  template: CrownTemplate;
  frame: CrownFrame;
  opening: GingivalOpening;
  mdMm?: number;
  antagonist?: RayCaster;
  params: Pick<DesignParams, 'occlusalClearanceMm'>;
}): { pose: Pose; warnings: string[] } {
  const { template, frame, opening } = input;
  const warnings: string[] = [];
  const axes = crownAxes(frame);
  const position = opening.centre;
  const nominal = template.size.md;
  let md = input.mdMm;
  if (md === undefined) {
    const m = frame.mesialContact, d = frame.distalContact;
    const fromContacts = m && d ? dot(sub(m, d), axes.x) : m ? 2 * Math.abs(dot(sub(m, position), axes.x)) : d ? 2 * Math.abs(dot(sub(d, position), axes.x)) : undefined;
    if (fromContacts !== undefined && fromContacts > 0.5 * nominal && fromContacts < 1.6 * nominal) md = fromContacts;
    else {
      if (fromContacts !== undefined) warnings.push('The neighbour contacts do not match the tooth; sized from the library tooth instead.');
      md = nominal;
    }
  }
  const bl = template.size.bl * Math.min(1.15, Math.max(0.85, md / nominal));
  let height = template.size.height;
  const up = input.antagonist?.first(position, axes.z, 30);
  const toAntagonist = up ? up.distance - input.params.occlusalClearanceMm : Infinity;
  if (toAntagonist <= MAX_HEIGHT_SCALE * template.size.height) height = toAntagonist;
  else warnings.push(up ? 'The antagonist is not above the implant; using the template height.' : 'No antagonist above the implant; using the template height.');
  height = Math.max(height, MIN_HEIGHT_MM);
  const q = poseRotation(axes);
  return {
    pose: { position, quaternion: [q.x, q.y, q.z, q.w], scale: [(axes.epsilon * md) / nominal, bl / template.size.bl, height / template.size.height] },
    warnings,
  };
}

// ---- Loop helpers (as crown.ts pairs a margin with the cervical ring) ------------------------------

function arcFractions(points: V3[]): number[] {
  const n = points.length;
  const cum = [0];
  for (let i = 1; i <= n; i++) {
    const a = points[i - 1]!, b = points[i % n]!;
    cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cum[n]!;
  return cum.slice(0, n).map((c) => c / total);
}

/** Order a closed loop CCW around `axis`, starting at the point furthest along `start`. */
function orderLoop(points: V3[], axis: V3, start: V3): V3[] {
  const [u, v] = planeBasis(axis);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, q = points[(i + 1) % points.length]!;
    area += dot(p, u) * dot(q, v) - dot(q, u) * dot(p, v);
  }
  let first = 0;
  for (let i = 1; i < points.length; i++) if (dot(points[i]!, start) > dot(points[first]!, start)) first = i;
  const n = points.length;
  return Array.from({ length: n }, (_, k) => points[area >= 0 ? (first + k) % n : (first - k + n) % n]!);
}

function sampleLoop(points: V3[], fractions: number[], f: number): V3 {
  const n = points.length;
  let i = 0;
  while (i < n - 1 && fractions[i + 1]! <= f) i++;
  const f0 = fractions[i]!;
  const f1 = i + 1 < n ? fractions[i + 1]! : 1;
  const t = f1 > f0 ? (f - f0) / (f1 - f0) : 0;
  const a = points[i]!, b = points[(i + 1) % n]!;
  return add(a, scale(sub(b, a), t));
}

/** Per cervical-ring vertex of a template, the next vertex up its column (for the wall tangent). */
const columnUp = new WeakMap<CrownTemplate, Map<number, number>>();
function nextUpOf(template: CrownTemplate): Map<number, number> {
  let map = columnUp.get(template);
  if (!map) {
    map = new Map();
    const best = new Map<number, { v: number; h: number }>();
    for (let v = 0; v < template.column.length; v++) {
      const h = template.heightFraction[v]!;
      if (h <= 0) continue;
      const c = template.column[v]!;
      const b = best.get(c);
      if (!b || h < b.h) best.set(c, { v, h });
    }
    template.cervicalLoop.forEach((v, c) => {
      const b = best.get(c);
      if (b) map!.set(v, b.v);
    });
    columnUp.set(template, map);
  }
  return map;
}

// ---- Screw channel -----------------------------------------------------------------------------

export interface ScrewChannelReport {
  angleDeg: number;
  azimuthDeg: number;
  /** On the implant axis at the library's ASC pivot (the screw-head seat). */
  pivot: V3;
  direction: V3;
  radiusMm: number;
  /** Where the channel axis leaves the restoration, its outer normal there, and that normal · occlusal and · lingual. */
  exit: { point: V3; normal: V3; occlusalDot: number; lingualDot: number } | null;
  /** Posterior: the exit faces occlusally (· occlusal > 0.5); anterior: lingually (· lingual > 0.3). */
  exitOk: boolean;
  /** Thinnest material around the channel (radially from its wall), and the required minimum. */
  minWallMm: number;
  requiredWallMm: number;
  wallOk: boolean;
  failures: string[];
}

/** The channel axis: from the pivot along the implant axis tilted by angle toward the azimuth (0 buccal, 90 mesial). */
export function screwChannelAxis(unit: ImplantUnit, frame: Pick<CrownFrame, 'buccal' | 'mesial'>): { pivot: V3; direction: V3 } {
  const { z } = implantBasis(unit.pose);
  const pivot = implantToWorld(unit.pose)([0, 0, unit.entry.ascPivotZMm]);
  const angle = (unit.channel?.angleDeg ?? 0) * DEG;
  const azimuth = (unit.channel?.azimuthDeg ?? 0) * DEG;
  const b = normalize(reject(frame.buccal, z));
  const m = normalize(reject(reject(frame.mesial, z), b));
  const toward = add(scale(b, Math.cos(azimuth)), scale(m, Math.sin(azimuth)));
  return { pivot, direction: normalize(add(scale(z, Math.cos(angle)), scale(toward, Math.sin(angle)))) };
}

/** Closed cylinder from `from` along `dir`. */
function cylinder(from: V3, dir: V3, radius: number, length: number): IndexedMesh {
  const [a, b] = planeBasis(dir);
  const n = CHANNEL_SEGMENTS;
  const positions = new Float32Array((2 * n + 2) * 3);
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < n; j++) {
      const phi = (2 * Math.PI * j) / n;
      positions.set(add(add(from, scale(dir, k * length)), add(scale(a, radius * Math.cos(phi)), scale(b, radius * Math.sin(phi)))), (k * n + j) * 3);
    }
  }
  positions.set(from, 2 * n * 3);
  positions.set(add(from, scale(dir, length)), (2 * n + 1) * 3);
  const indices: number[] = [];
  for (let j = 0; j < n; j++) {
    const j1 = (j + 1) % n;
    indices.push(j, j1, n + j1, j, n + j1, n + j, 2 * n, j1, j, 2 * n + 1, n + j, n + j1);
  }
  return { positions, indices: Uint32Array.from(indices) };
}

/**
 * Exit and wall checks of a screw channel on the restoration without the channel: the exit is where the channel
 * axis leaves the outer surface; the wall is the smallest radial distance from the channel's wall to a surface of the
 * restoration (outer or fitting), over sample points inside the material.
 */
export function measureScrewChannel(input: {
  mesh: IndexedMesh;
  unit: ImplantUnit;
  fdi: number;
  frame: Pick<CrownFrame, 'buccal' | 'mesial' | 'occlusal'>;
  wallMm?: number;
  /** Ray caster over `mesh` (built when omitted). */
  ray?: RayCaster;
}): ScrewChannelReport {
  const { unit, frame, fdi } = input;
  const required = input.wallMm ?? DEFAULT_CHANNEL_WALL_MM;
  const ray = input.ray ?? bvhRayCaster(createBvh({ positions: input.mesh.positions, indices: input.mesh.indices.slice() }));
  const { pivot, direction } = screwChannelAxis(unit, frame);
  const radius = unit.entry.channelDiameterMm / 2;
  const hits = ray.all(pivot, direction, 40);
  const failures: string[] = [];
  const occlusal = normalize(frame.occlusal);
  const lingual = scale(normalize(frame.buccal), -1);
  let exit: ScrewChannelReport['exit'] = null;
  const last = hits.at(-1);
  if (last) {
    const normal = normalize(last.normal);
    exit = { point: last.point, normal, occlusalDot: dot(normal, occlusal), lingualDot: dot(normal, lingual) };
  }
  const posterior = isPosterior(fdi);
  const exitOk = Boolean(exit) && (posterior ? exit!.occlusalDot > CHANNEL_EXIT_OCCLUSAL_MIN : exit!.lingualDot > CHANNEL_EXIT_LINGUAL_MIN);
  if (!exit) failures.push('The screw channel does not pass through the restoration.');
  else if (!exitOk) failures.push(posterior ? 'The screw channel exits buccally or proximally, not occlusally.' : 'The screw channel exits labially or incisally, not lingually.');

  // Wall: rays outward from the channel wall, between where the axis enters the material and where it leaves. The
  // openings are left out: on a surface inclined to the channel, its wall runs out over radius·tan(inclination).
  let minWall = Infinity;
  const first = hits[0];
  if (first && last && last.distance > first.distance) {
    const [e1, e2] = planeBasis(direction);
    const lip = (normal: V3) => {
      const c = Math.max(0.2, Math.abs(dot(normalize(normal), direction)));
      return (radius * Math.sqrt(1 - c * c)) / c + 0.2;
    };
    const t0 = first.distance + lip(first.normal), t1 = last.distance - lip(last.normal);
    const steps = Math.max(2, Math.ceil((t1 - t0) / 0.25));
    for (let s = 0; s <= steps; s++) {
      const t = t0 + ((t1 - t0) * s) / steps;
      for (let k = 0; k < 24; k++) {
        const phi = (2 * Math.PI * k) / 24;
        const out = add(scale(e1, Math.cos(phi)), scale(e2, Math.sin(phi)));
        const q = add(add(pivot, scale(direction, t)), scale(out, radius));
        const hit = ray.first(q, out, 15);
        // Only points inside the material: the first surface along the ray is left (its normal points along the ray).
        if (!hit || dot(hit.normal, out) <= 0) continue;
        minWall = Math.min(minWall, hit.distance);
      }
    }
  }
  const wallOk = minWall >= required - 1e-6;
  if (Number.isFinite(minWall) && !wallOk) failures.push(`The material around the screw channel is ${minWall.toFixed(2)} mm, under the ${required} mm minimum.`);
  return {
    angleDeg: unit.channel?.angleDeg ?? 0,
    azimuthDeg: unit.channel?.azimuthDeg ?? 0,
    pivot,
    direction,
    radiusMm: radius,
    exit,
    exitOk,
    minWallMm: minWall,
    requiredWallMm: required,
    wallOk,
    failures,
  };
}

/** The restoration with its screw channel subtracted (needs initMeshBoolean). */
export function cutScrewChannel(mesh: IndexedMesh, report: Pick<ScrewChannelReport, 'pivot' | 'direction' | 'radiusMm'>): IndexedMesh {
  return differenceMeshes(mesh, cylinder(sub(report.pivot, scale(report.direction, 0.5)), report.direction, report.radiusMm, 40));
}

/**
 * Auto-angle (classical.screw-channel): the straight channel if its exit and walls pass; otherwise the smallest angle
 * in the ASC cone (2.5° steps up to the library maximum, azimuths every 10°) whose exit and walls pass, the most
 * occlusal (posterior) or lingual (anterior) exit first. Null when none passes: the unit cannot be screw-retained here.
 */
export function proposeScrewChannel(input: {
  mesh: IndexedMesh;
  unit: ImplantUnit;
  fdi: number;
  frame: Pick<CrownFrame, 'buccal' | 'mesial' | 'occlusal'>;
  wallMm?: number;
}): { angleDeg: number; azimuthDeg: number; report: ScrewChannelReport } | null {
  const ray = bvhRayCaster(createBvh({ positions: input.mesh.positions, indices: input.mesh.indices.slice() }));
  const evaluate = (angleDeg: number, azimuthDeg: number) =>
    measureScrewChannel({ ...input, ray, unit: { ...input.unit, channel: { angleDeg, azimuthDeg } } });
  const straight = evaluate(0, 0);
  if (straight.exitOk && straight.wallOk) return { angleDeg: 0, azimuthDeg: 0, report: straight };
  const posterior = isPosterior(input.fdi);
  for (let angle = 2.5; angle <= input.unit.entry.ascMaxDeg + 1e-9; angle += 2.5) {
    let best: { azimuthDeg: number; report: ScrewChannelReport; score: number } | null = null;
    for (let az = 0; az < 360; az += 10) {
      const report = evaluate(angle, az);
      if (!report.exitOk || !report.wallOk || !report.exit) continue;
      const score = posterior ? report.exit.occlusalDot : report.exit.lingualDot;
      if (!best || score > best.score) best = { azimuthDeg: az, report, score };
    }
    if (best) return { angleDeg: angle, azimuthDeg: best.azimuthDeg, report: best.report };
  }
  return null;
}

// ---- Design ---------------------------------------------------------------------------------

export interface ImplantCrownInput {
  fdi: number;
  /** The jaw scan with the scan body (vertices and faces, and its ray caster). */
  jaw: { positions: Float32Array; indices: Uint32Array; ray: RayCaster };
  antagonist?: RayCaster;
  /** The tooth frame (implantToothFrame: origin on the gingival opening). */
  frame: CrownFrame;
  implant: ImplantUnit;
  /** Insertion axis: the implant axis for a single unit (default), the common path in a bridge. */
  axis?: V3;
  params: DesignParams;
  /** Stored pose; omitted = proposeImplantCrownPose. */
  pose?: Pose;
  /** Mesio-distal width for the proposal (a bridge's implant spacing). */
  mdMm?: number;
  template?: CrownTemplate;
  maps?: CrownMapName[];
  adapt?: CrownAdapt;
  neighbours?: { ray: RayCaster; faceMask?: Uint8Array };
  /** Cut the screw channel (default true; skipped with a warning before initMeshBoolean). */
  cutChannel?: boolean;
  /** The gingival opening, when already computed for this pose. */
  opening?: GingivalOpening;
}

export interface ImplantCrownExtras {
  libraryId: string;
  engaging: boolean;
  opening: { centre: V3; meanHeightMm: number; minHeightMm: number; maxHeightMm: number; coverage: number };
  /** The bonding gap between the Ti-base and the inner surface (tiBase.ts measureTiBaseGap). */
  tiBaseGap: TiBaseGapCheck;
  /** The inner surface's rim (the shoulder lifted by the gap), xyz per ring point. */
  rim: Float32Array;
  /** Rim points hidden under the Ti-base from the insertion path: > 0 = the restoration cannot be seated along it. */
  rimUndercutCount: number;
  gapMm: number;
  channel: ScrewChannelReport;
  /** The restoration with the screw channel (what is exported and merged), when the boolean engine was ready. */
  cut?: IndexedMesh;
  cutCheck?: { ok: boolean; selfIntersections: number; components: number; genus: number };
  emergenceRows: number;
}

export type ImplantCrownDesign = CrownDesign & { implant: ImplantCrownExtras };

/** The mesh a unit contributes to a union or an export: the cut restoration for implant crowns. */
export const restorationMeshOf = (design: CrownDesign): IndexedMesh => (design as Partial<ImplantCrownDesign>).implant?.cut ?? design.mesh;

/** Jaw faces on or touching the registered scan body: never neighbours (contacts and the proximal map ignore them). */
function scanBodyFaces(jaw: { positions: Float32Array; indices: Uint32Array }, entry: ImplantLibraryEntry, pose: ImplantPose): Uint8Array {
  const { ids } = scanBodyVertices(jaw.positions, entry, pose);
  const on = new Uint8Array(jaw.positions.length / 3);
  for (const v of ids) on[v] = 1;
  const faces = new Uint8Array(jaw.indices.length / 3);
  for (let f = 0; f < faces.length; f++) if (on[jaw.indices[f * 3]!] || on[jaw.indices[f * 3 + 1]!] || on[jaw.indices[f * 3 + 2]!]) faces[f] = 1;
  return faces;
}

/** An implant crown on its Ti-base; see the module comment. */
export function designImplantCrown(input: ImplantCrownInput): ImplantCrownDesign {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };
  const { jaw, frame, params, implant } = input;
  const { entry, pose: implantPose } = implant;
  const warnings: string[] = [];
  const template = input.template ?? templateForTooth(input.fdi);
  const implantAxis = implantBasis(implantPose).z;
  const axis = normalize(input.axis ?? implantAxis);
  const axes = crownAxes(frame);
  const gap = params.tiBaseGapMm ?? entry.bondingGapMm;
  const concavity = params.emergenceConcavity ?? DEFAULT_EMERGENCE_CONCAVITY;

  const opening = input.opening ?? gingivalOpening({ positions: jaw.positions, entry, pose: implantPose });
  if (opening.coverage < 0.5) warnings.push(`The gingiva meets the scan body on only ${Math.round(opening.coverage * 100)}% of its circumference in the scan.`);
  lap('opening');

  let pose = input.pose;
  if (!pose) {
    const proposal = proposeImplantCrownPose({ template, frame, opening, mdMm: input.mdMm, antagonist: input.antagonist, params });
    pose = proposal.pose;
    warnings.push(...proposal.warnings);
  }
  lap('pose');

  // The library tooth, its ring ordered CCW about the insertion axis from the mesial end.
  const placed = placeShell(template, pose, axis, axes.x);
  const T = placed.ring.length;

  // Rim: the Ti-base shoulder lifted by the bonding gap, paired with the ring by arc length.
  const band = IMPLANT_BAND_MM;
  const toWorld = implantToWorld(implantPose);
  const toLocal = worldToImplant(implantPose);
  const shoulder: V3[] = [];
  for (let i = 0; i < entry.shoulderLoop.length / 3; i++) {
    const [x, y, z] = pointAt(entry.shoulderLoop, i);
    shoulder.push(toWorld([x, y, z + gap]));
  }
  const ordered = orderLoop(shoulder, axis, axes.x);
  const fractions = arcFractions(ordered);
  const rim = new Float32Array(T * 3);
  for (let i = 0; i < T; i++) rim.set(sampleLoop(ordered, fractions, placed.fractions[i]!), i * 3);
  lap('pairing');

  // Inner surface on the Ti-base.
  const fit = tiBaseFittingSurface({ entry, pose: implantPose, gapMm: gap, axis, rim });
  warnings.push(...fit.warnings);
  // Seating: from each rim point, the insertion direction must be free of the (offset) Ti-base.
  const offsetRay = bvhRayCaster(createBvh({ positions: fit.offset.positions, indices: fit.offset.indices.slice() }));
  let rimUndercutCount = 0;
  for (let i = 0; i < T; i++) if (offsetRay.first(add(pointAt(rim, i), scale(axis, 1e-3)), axis, 30)) rimUndercutCount++;
  if (rimUndercutCount > 0) {
    warnings.push(`${rimUndercutCount} points of the Ti-base shoulder are hidden under the Ti-base from the insertion path: the restoration cannot be seated (reduce the divergence or use a shorter Ti-base).`);
  }
  lap('intaglio');

  // Ring targets: the posed ring moved along occlusal onto the gingival opening's height at its azimuth, and never
  // inside the Ti-base collar (plus a flare): the emergence widens from the platform, it never undercuts itself.
  const occlusal = axes.z;
  const along = dot(occlusal, implantAxis) || 1;
  let shoulderZ = -Infinity, collar = 0;
  for (let i = 0; i < entry.shoulderLoop.length; i += 3) {
    shoulderZ = Math.max(shoulderZ, entry.shoulderLoop[i + 2]!);
    collar = Math.max(collar, Math.hypot(entry.shoulderLoop[i]!, entry.shoulderLoop[i + 1]!));
  }
  const ringTargets = new Float32Array(T * 3);
  placed.ringPoints.forEach((p, i) => {
    const q = toLocal(p);
    const height = Math.max(openingHeightAt(opening, Math.atan2(q[1], q[0])), shoulderZ + gap + MIN_EMERGENCE_HEIGHT_MM);
    const moved = toLocal(add(p, scale(occlusal, (height - q[2]) / along)));
    const r = Math.hypot(moved[0], moved[1]);
    const k = r > 0 && r < collar + MIN_EMERGENCE_FLARE_MM ? (collar + MIN_EMERGENCE_FLARE_MM) / r : 1;
    ringTargets.set(toWorld([moved[0] * k, moved[1] * k, moved[2]]), i * 3);
  });

  // Emergence rows: per column a Hermite curve from the outer loop (shoulder) up to the fitted ring.
  const nextUp = nextUpOf(template);
  let emergenceRows = 0;
  const rows = (outer: Float32Array, shell: Float32Array): Float32Array[] => {
    let maxLen = 0;
    for (let i = 0; i < T; i++) maxLen = Math.max(maxLen, Math.hypot(...sub(pointAt(shell, placed.ring[i]!), pointAt(outer, i))));
    const K = Math.min(12, Math.max(2, Math.round(maxLen / EMERGENCE_STEP_MM)));
    emergenceRows = K + 1;
    const out = Array.from({ length: K }, () => new Float32Array(T * 3));
    for (let i = 0; i < T; i++) {
      const v = placed.ring[i]!;
      const p0 = pointAt(outer, i), p1 = pointAt(shell, v);
      const chord = sub(p1, p0);
      const len = Math.hypot(...chord) || 1e-6;
      const up = nextUp.get(v);
      const wall = up !== undefined ? normalize(sub(pointAt(shell, up), p1)) : normalize(chord);
      // The start tangent leans toward the insertion axis (not the implant axis): on a common path the intaglio's
      // blockout rises along it right next to the shoulder, and the emergence must not cross it.
      const t0 = scale(normalize(add(scale(chord, (1 - concavity) / len), scale(axis, concavity))), len);
      const t1 = scale(wall, len);
      for (let k = 1; k <= K; k++) {
        const s = k / (K + 1);
        const s2 = s * s, s3 = s2 * s;
        const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
        out[k - 1]!.set(add(add(scale(p0, h00), scale(t0, h10)), add(scale(p1, h01), scale(t1, h11))), i * 3);
      }
    }
    return out;
  };

  const finished = fitAndFinishShell({
    placed,
    pose,
    axes,
    axis,
    inner: fit.intaglio,
    rim,
    bandMm: band,
    params,
    thickness: 'enforce',
    jawRay: jaw.ray,
    ignoredFaces: () => scanBodyFaces(jaw, entry, implantPose),
    antagonist: input.antagonist,
    adapt: input.adapt,
    maps: input.maps,
    neighbours: input.neighbours,
    gapCheck: () => ({ samples: fit.gap.tiBaseSamples, meanErrorMm: fit.gap.meanErrorMm, maxErrorMm: fit.gap.maxErrorMm }),
    emergence: { ringTargets, rows },
    warnings,
    timings,
    lap,
  });
  const design = finished.design;

  // Screw channel: checks on the restoration, then the cut.
  const channel = measureScrewChannel({ mesh: design.mesh, unit: implant, fdi: input.fdi, frame, wallMm: params.channelWallMm });
  warnings.push(...channel.failures);
  lap('channel');
  let cut: IndexedMesh | undefined;
  let cutCheck: ImplantCrownExtras['cutCheck'];
  if (input.cutChannel !== false) {
    if (!meshBooleanReady()) warnings.push('The screw channel is not cut: the boolean engine is not loaded.');
    else {
      try {
        cut = cutScrewChannel(design.mesh, channel);
        const v = validateClosedMesh(cut);
        const topo = meshTopology(cut);
        const selfIntersections = countSelfIntersections(cut).count;
        cutCheck = { ok: v.ok && selfIntersections === 0 && topo.components === 1 && topo.genus === 1, selfIntersections, components: topo.components, genus: topo.genus };
        if (!cutCheck.ok) warnings.push(`The restoration with the screw channel is not one clean solid (${topo.components} parts, genus ${topo.genus}).`);
      } catch (error) {
        warnings.push(`The screw channel could not be cut: ${(error as Error).message}`);
      }
    }
    lap('cut');
  }

  return {
    ...design,
    implant: {
      libraryId: entry.key,
      engaging: entry.engaging,
      opening: {
        centre: opening.centre,
        meanHeightMm: opening.meanHeightMm,
        minHeightMm: opening.minHeightMm,
        maxHeightMm: opening.maxHeightMm,
        coverage: opening.coverage,
      },
      tiBaseGap: fit.gap,
      rim,
      rimUndercutCount,
      gapMm: gap,
      channel,
      ...(cut ? { cut } : {}),
      ...(cutCheck ? { cutCheck } : {}),
      emergenceRows,
    },
  };
}
