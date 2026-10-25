import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import { scanSections } from './sectionArea';

/**
 * Bridge connectors: one elliptical tube per connection, along the line
 * between the two unit centres (⊥ the insertion axis), so its cross-section
 * has its height along the insertion axis and its width bucco-lingually.
 *
 * Placement: the centre is the midpoint of the units' facing shell points
 * (each unit's contact area toward the other) plus the stored buccal and
 * occlusal offsets, kept inside the available height:
 * - bottom: at least CONNECTOR_HYGIENE_MM above the gingiva or ridge under
 *   it (ray cast along −axis), so it can be cleaned;
 * - top: at least CONNECTOR_EMBRASURE_MM below the lower marginal ridge or
 *   incisal edge of the two units (the occlusal embrasure).
 *
 * Sizing for a target area A: h = min(available, max(√(4A/π), minimum
 * height)) and w = 4A/(πh): a circle when it is tall enough, otherwise as
 * tall as the minimum (or the room) allows and wider to keep the area. The
 * polygon is scaled so its area is A (plus CONNECTOR_AREA_MARGIN, so float32
 * rounding never measures below A). It fails with "insufficient connector
 * height" when h is below the minimum height, and "connector too wide" when w
 * exceeds CONNECTOR_MAX_WIDTH_FRACTION of the narrower unit.
 *
 * Ends: each end sinks into its unit by min(1 mm, the depth at which the end
 * cap comes within CONNECTOR_FIT_CLEARANCE_MM of that unit's fitting surface),
 * so a connector never reaches the intaglio or the pontic base.
 */

export const CONNECTOR_HYGIENE_MM = 1.0;
export const CONNECTOR_EMBRASURE_MM = 1.0;
/** A connector may be at most this fraction of the narrower unit's bucco-lingual width. */
export const CONNECTOR_MAX_WIDTH_FRACTION = 0.8;
/** Connector ends stay this far from the units' fitting surfaces. */
export const CONNECTOR_FIT_CLEARANCE_MM = 0.2;
/** Connector ends sink at most this deep into their units. */
export const CONNECTOR_MAX_SINK_MM = 1.0;
/** Relative area margin of the tube polygon over the designed area. */
export const CONNECTOR_AREA_MARGIN = 5e-4;
/** Shell vertices within this distance of a unit's extreme toward the other unit form its facing (contact) area. */
const FACING_BAND_MM = 0.3;
/** The marginal ridge (or incisal edge) is the highest shell point within this distance of the facing extreme. */
const MARGINAL_RIDGE_BAND_MM = 1.5;
/** Sink search step. */
const SINK_STEP_MM = 0.05;
/** The smallest sink kept, so the tube always overlaps its unit. */
const MIN_SINK_MM = 0.1;
/** Smallest cross-section dimension of the generated tube (a failed connector still gets a visible mesh). */
const MIN_TUBE_MM = 0.5;

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

/** One end of a connection: a designed unit (retainer or pontic). */
export interface ConnectorUnit {
  fdi: number;
  /** The unit's closed mesh; outer-shell vertices are [shellStart, end). */
  mesh: IndexedMesh;
  shellStart: number;
  /** Ray caster over the whole unit mesh (where the connector line enters it). */
  solid: RayCaster;
  /** The unit's fitting surface (retainer intaglio, pontic base). */
  inner: RayCaster;
  /** Unit centre (its pose position): the connector runs along the line between the centres. */
  centre: V3;
  /** Buccal direction of the unit's frame. */
  buccal: V3;
  /** Bucco-lingual width of the unit, mm. */
  blMm: number;
}

export interface ConnectorInput {
  /** The connection, sorted; `a` is between[0]. */
  between: [number, number];
  a: ConnectorUnit;
  b: ConnectorUnit;
  /** The bridge's common insertion axis: connector heights are measured along it. */
  axis: V3;
  /** Designed cross-section (ConnectorDesign.areaMm2, never below the material minimum). */
  areaMm2: number;
  /** Stored offsets from the automatic position (ConnectorDesign). */
  buccalMm: number;
  occlusalMm: number;
  /** BRIDGE_PRESETS[material].connectorMinHeightMm. */
  minHeightMm: number;
  /** The jaw scan: the gingiva or ridge under the connector. */
  jaw: RayCaster;
  /** Polygon segments of the cross-section. */
  segments?: number;
}

export type ConnectorFailureCode = 'insufficient-height' | 'too-wide';

export interface ConnectorFailure {
  code: ConnectorFailureCode;
  message: string;
  valueMm: number;
  limitMm: number;
}

export interface ConnectorEnd {
  fdi: number;
  /** End-cap centre (inside the unit). */
  point: V3;
  /** Depth of the end below the unit's surface along the connector line. */
  sinkMm: number;
  /** Smallest distance from the end cap to the unit's fitting surface. */
  fitClearanceMm: number;
}

export interface ConnectorGeometry {
  between: [number, number];
  /** Closed, outward-oriented tube. */
  mesh: IndexedMesh;
  /** Cross-section centre. */
  centre: V3;
  /** Unit connector line, from between[0] toward between[1], ⊥ axis. */
  direction: V3;
  /** Cross-section axes: height along the insertion axis, width bucco-lingually (toward buccal). */
  heightDir: V3;
  widthDir: V3;
  areaMm2: number;
  heightMm: number;
  widthMm: number;
  /** Room between the gingiva + hygiene distance (bottom) and the marginal ridge − embrasure (top), on the connector's vertical line. */
  available: { heightMm: number; bottom: V3; top: V3 };
  /** Tube extent along the line, relative to the centre: [between[0] end, between[1] end]. */
  span: [number, number];
  ends: [ConnectorEnd, ConnectorEnd];
  failures: ConnectorFailure[];
  warnings: string[];
}

/** The unit's facing area toward `dir`: the mean of its shell points near the extreme, and the marginal ridge height there. */
function facing(unit: ConnectorUnit, dir: V3, axis: V3): { point: V3; ridge: number } {
  const P = unit.mesh.positions;
  const nv = P.length / 3;
  let max = -Infinity;
  for (let v = unit.shellStart; v < nv; v++) max = Math.max(max, dot(pointAt(P, v), dir));
  let sum: V3 = [0, 0, 0];
  let count = 0;
  let ridge = -Infinity;
  for (let v = unit.shellStart; v < nv; v++) {
    const p = pointAt(P, v);
    const along = dot(p, dir);
    if (along >= max - FACING_BAND_MM) {
      sum = add(sum, p);
      count++;
    }
    if (along >= max - MARGINAL_RIDGE_BAND_MM) ridge = Math.max(ridge, dot(p, axis));
  }
  return { point: scale(sum, 1 / count), ridge };
}

/** Unit-local polygon of the cross-section: N points on the ellipse (w/2, h/2), scaled to the area. */
function sectionPolygon(widthMm: number, heightMm: number, segments: number): Array<[number, number]> {
  // An inscribed N-gon with uniform parameter angles has area (N/2)·sin(2π/N)·a·b.
  const k = Math.sqrt(((1 + CONNECTOR_AREA_MARGIN) * Math.PI) / ((segments / 2) * Math.sin((2 * Math.PI) / segments)));
  return Array.from({ length: segments }, (_, i) => {
    const theta = (2 * Math.PI * i) / segments;
    return [(widthMm / 2) * k * Math.cos(theta), (heightMm / 2) * k * Math.sin(theta)];
  });
}

/** Smallest distance from a cross-section polygon placed at `at` to a surface (Infinity beyond 5 mm). */
function capClearance(at: V3, polygon: Array<[number, number]>, widthDir: V3, heightDir: V3, surface: RayCaster): number {
  let min = surface.closestPoint(at, 5)?.distance ?? Infinity;
  for (const [x, y] of polygon) {
    const p = add(at, add(scale(widthDir, x), scale(heightDir, y)));
    min = Math.min(min, surface.closestPoint(p, 5)?.distance ?? Infinity);
  }
  return min;
}

/**
 * Design one connector between two designed units; see the module comment.
 * Always returns a closed mesh; failures are reported, not thrown.
 */
export function designConnector(input: ConnectorInput): ConnectorGeometry {
  const { a, b, minHeightMm } = input;
  const axis = normalize(input.axis);
  const warnings: string[] = [];
  const failures: ConnectorFailure[] = [];
  const label = `${input.between[0]}–${input.between[1]}`;
  const segments = input.segments ?? 48;

  let direction = reject(sub(b.centre, a.centre), axis);
  if (Math.hypot(...direction) < 1e-6) throw new Error(`Connector ${label}: the units are on top of each other`);
  direction = normalize(direction);
  let widthDir = normalize(cross(axis, direction));
  if (dot(widthDir, add(a.buccal, b.buccal)) < 0) widthDir = scale(widthDir, -1);

  // Automatic centre: midpoint of the facing areas, plus the stored offsets.
  const fa = facing(a, direction, axis);
  const fb = facing(b, scale(direction, -1), axis);
  const auto = scale(add(fa.point, fb.point), 0.5);
  const c0 = add(auto, add(scale(widthDir, input.buccalMm), scale(axis, input.occlusalMm)));

  // Available height on the connector's vertical line.
  const gingiva = input.jaw.first(add(c0, scale(axis, 15)), scale(axis, -1), 40);
  const z0 = dot(c0, axis);
  let bottom: number;
  if (gingiva) bottom = dot(gingiva.point, axis) + CONNECTOR_HYGIENE_MM;
  else {
    warnings.push(`Connector ${label}: no gingiva or ridge found under it; the hygiene distance is not checked.`);
    bottom = -Infinity;
  }
  const top = Math.min(fa.ridge, fb.ridge) - CONNECTOR_EMBRASURE_MM;
  const lowest = Number.isFinite(bottom) ? bottom : top - 3 * minHeightMm;
  const availableMm = top - lowest;

  // Sizing.
  const area = input.areaMm2;
  const circle = Math.sqrt((4 * area) / Math.PI);
  const heightMm = Math.min(availableMm, Math.max(circle, minHeightMm));
  const tubeHeight = Math.max(heightMm, MIN_TUBE_MM);
  const widthMm = (4 * area) / (Math.PI * tubeHeight);
  if (heightMm < minHeightMm - 1e-9) {
    failures.push({
      code: 'insufficient-height',
      message: `Insufficient connector height (${label}): ${Math.max(0, availableMm).toFixed(2)} mm available, ${minHeightMm} mm required.`,
      valueMm: heightMm,
      limitMm: minHeightMm,
    });
  }
  const maxWidth = CONNECTOR_MAX_WIDTH_FRACTION * Math.min(a.blMm, b.blMm);
  if (widthMm > maxWidth) {
    failures.push({
      code: 'too-wide',
      message: `Connector too wide (${label}): ${widthMm.toFixed(2)} mm, at most ${maxWidth.toFixed(2)} mm (${CONNECTOR_MAX_WIDTH_FRACTION * 100}% of the narrower unit).`,
      valueMm: widthMm,
      limitMm: maxWidth,
    });
  }

  // Keep the section inside the available height.
  const lo = lowest + tubeHeight / 2;
  const hi = top - tubeHeight / 2;
  const z = lo <= hi ? Math.min(Math.max(z0, lo), hi) : (lowest + top) / 2;
  if (Math.abs(z - z0) > 0.05 && input.occlusalMm !== 0) {
    warnings.push(`Connector ${label}: the occlusal offset was limited to keep the connector inside the embrasures.`);
  }
  const centre = add(c0, scale(axis, z - z0));
  const polygon = sectionPolygon(widthMm, tubeHeight, segments);

  // Ends: where the connector line enters each unit, then sunk into it.
  const end = (unit: ConnectorUnit, sign: 1 | -1): { t: number; end: ConnectorEnd } => {
    const toward = scale(direction, sign); // from the centre toward this unit
    const hits = unit.solid.all(centre, toward, 40);
    let surface: number; // signed position of the unit's surface on the line
    if (hits.length % 2 === 1) {
      // The centre is inside this unit: its surface is where the line leaves it toward the other unit.
      const exit = unit.solid.first(centre, scale(toward, -1), 40);
      surface = exit ? -sign * exit.distance : 0;
    } else if (hits.length > 0) {
      surface = sign * hits[0]!.distance;
    } else {
      warnings.push(`Connector ${label}: its line misses unit ${unit.fdi}; it ends at the unit's facing area.`);
      surface = dot(sub(sign === -1 ? fa.point : fb.point, centre), direction);
    }
    const at = (sink: number) => add(centre, scale(direction, surface + sign * sink));
    const clearance = (sink: number) => capClearance(at(sink), polygon, widthDir, axis, unit.inner);
    let sink = Math.min(CONNECTOR_MAX_SINK_MM, clearance(0) - CONNECTOR_FIT_CLEARANCE_MM);
    while (sink > MIN_SINK_MM && clearance(sink) < CONNECTOR_FIT_CLEARANCE_MM) sink -= SINK_STEP_MM;
    if (sink < MIN_SINK_MM) {
      sink = MIN_SINK_MM;
      warnings.push(`Connector ${label}: the end in unit ${unit.fdi} is within ${CONNECTOR_FIT_CLEARANCE_MM} mm of its fitting surface.`);
    }
    return { t: surface + sign * sink, end: { fdi: unit.fdi, point: at(sink), sinkMm: sink, fitClearanceMm: clearance(sink) } };
  };
  const ea = end(a, -1);
  const eb = end(b, 1);
  let [tA, tB] = [ea.t, eb.t];
  if (tB - tA < 2 * MIN_SINK_MM) {
    const mid = (tA + tB) / 2;
    [tA, tB] = [mid - MIN_SINK_MM, mid + MIN_SINK_MM];
  }

  return {
    between: input.between,
    mesh: tubeMesh(centre, direction, widthDir, axis, polygon, tA, tB),
    centre,
    direction,
    heightDir: axis,
    widthDir,
    areaMm2: area,
    heightMm,
    widthMm,
    available: { heightMm: availableMm, bottom: add(centre, scale(axis, lowest - z)), top: add(centre, scale(axis, top - z)) },
    span: [tA, tB],
    ends: [ea.end, eb.end],
    failures,
    warnings,
  };
}

/** Closed prism along `dir` from t0 to t1 over the section polygon (u along widthDir, v along heightDir), outward. */
function tubeMesh(centre: V3, dir: V3, widthDir: V3, heightDir: V3, polygon: Array<[number, number]>, t0: number, t1: number): IndexedMesh {
  const n = polygon.length;
  const positions = new Float32Array((2 * n + 2) * 3);
  const ring = (t: number, offset: number) => {
    polygon.forEach(([x, y], i) => positions.set(add(centre, add(scale(dir, t), add(scale(widthDir, x), scale(heightDir, y)))), (offset + i) * 3));
  };
  ring(t0, 0);
  ring(t1, n);
  positions.set(add(centre, scale(dir, t0)), 2 * n * 3);
  positions.set(add(centre, scale(dir, t1)), (2 * n + 1) * 3);
  // The polygon runs counter-clockwise around +dir when widthDir × heightDir = +dir.
  const ccw = dot(cross(widthDir, heightDir), dir) > 0;
  const tri = (p: number, q: number, r: number): [number, number, number] => (ccw ? [p, q, r] : [p, r, q]);
  const indices = new Uint32Array(4 * n * 3);
  let o = 0;
  const c0 = 2 * n, c1 = 2 * n + 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.set(tri(i, j, n + j), o);
    indices.set(tri(i, n + j, n + i), o + 3);
    indices.set(tri(c0, j, i), o + 6);
    indices.set(tri(c1, n + i, n + j), o + 9);
    o += 12;
  }
  return { positions, indices };
}

/** A connector measured on the merged bridge: its weakest cross-section across the gap. */
export interface ConnectorMeasure {
  /** Smallest section area over planes ⊥ the connector line between its ends. */
  minAreaMm2: number;
  /** Extent of that section along the insertion axis and bucco-lingually. */
  heightMm: number;
  widthMm: number;
  /** Where the smallest section is (on the connector line). */
  at: V3;
  planes: number;
}

/**
 * Measure a connector on the union: planes ⊥ its line, from just inside one
 * end to just inside the other (exocad's moving cross-section plane, as a
 * check), keeping only the section loops near the line.
 */
export function measureConnector(union: Pick<IndexedMesh, 'positions' | 'indices'>, c: ConnectorGeometry, planes = 25): ConnectorMeasure {
  const inset = 0.05;
  const from = add(c.centre, scale(c.direction, c.span[0] + inset));
  const to = add(c.centre, scale(c.direction, c.span[1] - inset));
  const scan = scanSections(union, { from, to, steps: planes, radiusMm: Math.max(c.widthMm, c.heightMm) / 2 + 3 });
  let hMin = Infinity, hMax = -Infinity, wMin = Infinity, wMax = -Infinity;
  for (const loop of scan.section.loops) {
    for (let i = 0; i < loop.points.length; i += 3) {
      const p = pointAt(loop.points, i / 3);
      hMin = Math.min(hMin, dot(p, c.heightDir));
      hMax = Math.max(hMax, dot(p, c.heightDir));
      wMin = Math.min(wMin, dot(p, c.widthDir));
      wMax = Math.max(wMax, dot(p, c.widthDir));
    }
  }
  return {
    minAreaMm2: scan.minAreaMm2,
    heightMm: Number.isFinite(hMax) ? hMax - hMin : 0,
    widthMm: Number.isFinite(wMax) ? wMax - wMin : 0,
    at: scan.at.point,
    planes,
  };
}
