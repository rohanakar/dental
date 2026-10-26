import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import { scanSections } from './sectionArea';
import { signedIntaglioDistance, type IntaglioSurface } from './thickness';

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
 * comes within CONNECTOR_FIT_CLEARANCE_MM of that unit's fitting surface), so
 * a connector never reaches the intaglio or the pontic base. The clearance is
 * the signed distance to the fitting surface (negative = through it), sampled
 * densely over the end cap and the side wall next to it. A wall too thin for
 * both the clearance and a MIN_SINK_MM overlap fails with "fit-clearance";
 * the end then sinks less, and never as far as the fitting surface.
 *
 * Maryland wings (ConnectorUnit.wing): the section is centred on the wing's
 * proximal part facing the other unit; the end sinks at most the wing
 * thickness − 0.2 mm and stays WING_FIT_CLEARANCE_MM from the fitting surface,
 * measured over the part of the end inside the wing; the rest of the
 * connector must clear the natural tooth by the cement gap, at its place and
 * along the insertion path ('tooth-clash').
 *
 * Inlays and onlays (ConnectorUnit.inlay): the connector sits in the proximal
 * box facing the other unit, centred between its walls; its bottom is also at least
 * boxFloorClearanceMm above the box's gingival floor (the lowest fitting
 * point within INLAY_BOX_BAND_MM of the side facing the other unit); when
 * that floor sets the bottom and the height is short, it fails with
 * 'box-too-shallow'. Its width is at least minWidthMm (3 mm for inlay
 * bridges): a narrower section is widened, which only adds area.
 */

export const CONNECTOR_HYGIENE_MM = 1.0;
export const CONNECTOR_EMBRASURE_MM = 1.0;
/** A connector may be at most this fraction of the narrower unit's bucco-lingual width. */
export const CONNECTOR_MAX_WIDTH_FRACTION = 0.8;
/** Connector ends stay this far from the units' fitting surfaces. */
export const CONNECTOR_FIT_CLEARANCE_MM = 0.2;
/**
 * In a Maryland wing the end stays this far from the fitting surface (it never goes through it). The wing is 0.7 mm
 * thick and feathered toward its outline, so the 0.2 mm wall of a crown would keep a connector off most of its
 * proximal part; the sink is capped at the wing thickness − 0.2 mm instead (ConnectorUnit.wing.maxSinkMm).
 */
export const WING_FIT_CLEARANCE_MM = 0.05;
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
/** The overlap with its unit every connector end needs (for a robust union); a thinner wall fails 'fit-clearance'. */
const MIN_SINK_MM = 0.1;
/** Float rounding allowed on the fit clearance (0.1 µm). */
const FIT_CLEARANCE_TOLERANCE_MM = 1e-4;
/** Fitting-surface distances are searched this far (beyond it, the clearance is Infinity). */
const FIT_SEARCH_MM = 5;
/** Smallest cross-section dimension of the generated tube (a failed connector still gets a visible mesh). */
const MIN_TUBE_MM = 0.5;
/** An inlay's proximal box: its fitting surface within this distance of the side facing the other unit. */
export const INLAY_BOX_BAND_MM = 2;

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
/** The clearance a connector end keeps from its unit's fitting surface. */
const fitClearanceOf = (unit: { wing?: unknown }): number => (unit.wing ? WING_FIT_CLEARANCE_MM : CONNECTOR_FIT_CLEARANCE_MM);
const pointAt = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/** One end of a connection: a designed unit (retainer or pontic). */
export interface ConnectorUnit {
  fdi: number;
  /** The unit's closed mesh; outer-shell vertices are [shellStart, end). */
  mesh: IndexedMesh;
  shellStart: number;
  /** Ray caster over the whole unit mesh (where the connector line enters it). */
  solid: RayCaster;
  /** The unit's fitting surface (retainer intaglio, pontic base), faces pointing out of the material. */
  inner: IntaglioSurface;
  /** Unit centre (its pose position): the connector runs along the line between the centres. */
  centre: V3;
  /** Buccal direction of the unit's frame. */
  buccal: V3;
  /** Bucco-lingual width of the unit, mm. */
  blMm: number;
  /**
   * A Maryland wing on a natural tooth: the end sinks at most `maxSinkMm` (the wing thickness − 0.2 mm), and the
   * connector must clear the tooth (toothClearance): by the cement gap, and along the insertion path.
   */
  wing?: { maxSinkMm: number; cementGapMm: number };
  /**
   * An inlay or onlay: the connector sits in the proximal box, at least `boxFloorClearanceMm` above its gingival
   * floor, and is at least `minWidthMm` wide.
   */
  inlay?: { boxFloorClearanceMm: number; minWidthMm: number };
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

/**
 * 'insufficient-height': less room than the minimum height; 'too-wide': wider than CONNECTOR_MAX_WIDTH_FRACTION of
 * the narrower unit; 'fit-clearance': an end closer than CONNECTOR_FIT_CLEARANCE_MM to its unit's fitting surface;
 * 'tooth-clash': a connector to a Maryland wing hits the natural tooth, or passes it closer than the cement gap,
 * where it is not inside the wing, at its place or along the insertion path; 'box-too-shallow': less room than the
 * minimum height because an inlay's proximal box floor sets the bottom.
 */
export type ConnectorFailureCode = 'insufficient-height' | 'box-too-shallow' | 'too-wide' | 'fit-clearance' | 'tooth-clash';

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
  /**
   * Smallest signed distance from the end (cap and the side wall next to it) to the unit's fitting surface:
   * negative = through it; Infinity = none within 5 mm. Below CONNECTOR_FIT_CLEARANCE_MM it is a 'fit-clearance' failure.
   */
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
  /** Connectors to a Maryland wing: the clearance to the natural tooth (toothClearance). */
  toothClearance?: ToothClearance;
  failures: ConnectorFailure[];
  warnings: string[];
}

/**
 * An inlay's proximal box toward `dir` (its fitting surface within INLAY_BOX_BAND_MM of the side facing `dir`): the
 * floor (its lowest point along `axis`) and the middle of its walls along `widthDir`.
 */
function proximalBox(unit: ConnectorUnit, dir: V3, axis: V3, widthDir: V3): { floor: number; middle: number } {
  const P = unit.mesh.positions;
  let max = -Infinity;
  for (let v = 0; v < unit.shellStart; v++) max = Math.max(max, dot(pointAt(P, v), dir));
  let floor = Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (let v = 0; v < unit.shellStart; v++) {
    const p = pointAt(P, v);
    if (dot(p, dir) < max - INLAY_BOX_BAND_MM) continue;
    floor = Math.min(floor, dot(p, axis));
    const w = dot(p, widthDir);
    lo = Math.min(lo, w);
    hi = Math.max(hi, w);
  }
  return { floor, middle: (lo + hi) / 2 };
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

/**
 * A wing's proximal part facing `dir`: the area-weighted centroid of its outer faces whose normal is within 60° of
 * `dir` (the proximal wrap of the outline); the facing area when it has none.
 */
function proximalPart(unit: ConnectorUnit, dir: V3): V3 {
  const P = unit.mesh.positions;
  const idx = unit.mesh.indices;
  let sum: V3 = [0, 0, 0];
  let total = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const ia = idx[f]!, ib = idx[f + 1]!, ic = idx[f + 2]!;
    if (ia < unit.shellStart || ib < unit.shellStart || ic < unit.shellStart) continue;
    const pa = pointAt(P, ia), pb = pointAt(P, ib), pc = pointAt(P, ic);
    const n = cross(sub(pb, pa), sub(pc, pa));
    const area2 = Math.hypot(n[0], n[1], n[2]);
    if (area2 < 1e-12 || dot(n, dir) < 0.5 * area2) continue;
    sum = add(sum, scale(add(add(pa, pb), pc), area2 / 3));
    total += area2;
  }
  return total > 0 ? scale(sum, 1 / total) : facing(unit, dir, dir).point;
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

/**
 * Sample points of a connector end, relative to its cap centre and as offsets (x along widthDir, y along heightDir,
 * d back along the line toward the connector centre, as a fraction of the sink): the cap centre, its polygon vertices
 * on rings at 1, 2/3 and 1/3 of the rim, the rim edge midpoints, and the rim halfway back up the side wall.
 */
function endSamples(polygon: Array<[number, number]>): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [[0, 0, 0]];
  polygon.forEach(([x, y], i) => {
    const [nx, ny] = polygon[(i + 1) % polygon.length]!;
    for (const f of [1, 2 / 3, 1 / 3]) out.push([f * x, f * y, 0]);
    out.push([(x + nx) / 2, (y + ny) / 2, 0]);
    out.push([x, y, 0.5]);
  });
  return out;
}

/**
 * Smallest signed distance from a connector end to a fitting surface (positive on the material side, negative
 * through it; Infinity beyond FIT_SEARCH_MM). `cap` is the end-cap centre, `back` the unit vector from it toward
 * the connector centre and `sink` the end's depth (for the side-wall samples).
 */
function endClearance(
  cap: V3,
  back: V3,
  sink: number,
  samples: Array<[number, number, number]>,
  widthDir: V3,
  heightDir: V3,
  surface: IntaglioSurface,
  within?: RayCaster,
): number {
  let min = Infinity;
  for (const [x, y, d] of samples) {
    const p = add(cap, add(add(scale(widthDir, x), scale(heightDir, y)), scale(back, d * sink)));
    // A wing end: only the part inside the wing counts; beside the wing the tooth clearance applies (toothClearance).
    if (within && within.all(p, heightDir, 60).length % 2 === 0) continue;
    const s = signedIntaglioDistance(p, surface, FIT_SEARCH_MM);
    if (s) min = Math.min(min, s.distance);
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
  let auto = scale(add(fa.point, fb.point), 0.5);
  // A Maryland wing: the section is centred on the wing's proximal part facing the other unit (the connector attaches
  // there, lingual of the contact area); along the line it stays between the units.
  const wingPart = a.wing ? proximalPart(a, direction) : b.wing ? proximalPart(b, scale(direction, -1)) : null;
  if (wingPart) auto = add(auto, reject(sub(wingPart, auto), direction));
  // An inlay: the section is centred bucco-lingually on the proximal box it passes through.
  const boxes = ([[a, direction], [b, scale(direction, -1)]] as Array<[ConnectorUnit, V3]>)
    .filter(([unit]) => unit.inlay)
    .map(([unit, dir]) => ({ unit, box: proximalBox(unit, dir, axis, widthDir) }));
  if (boxes.length) auto = add(auto, scale(widthDir, boxes.reduce((s, x) => s + x.box.middle, 0) / boxes.length - dot(auto, widthDir)));
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
  // An inlay's proximal box: the connector stays above its gingival floor.
  let boxBottom = -Infinity;
  for (const { unit, box } of boxes) boxBottom = Math.max(boxBottom, box.floor + unit.inlay!.boxFloorClearanceMm);
  const boxLimited = boxBottom > bottom;
  if (boxLimited) bottom = boxBottom;
  const lowest = Number.isFinite(bottom) ? bottom : top - 3 * minHeightMm;
  const availableMm = top - lowest;

  // Sizing.
  const area = input.areaMm2;
  const circle = Math.sqrt((4 * area) / Math.PI);
  const heightMm = Math.min(availableMm, Math.max(circle, minHeightMm));
  const tubeHeight = Math.max(heightMm, MIN_TUBE_MM);
  // An inlay bridge's connector is at least its minimum width (widening only adds area).
  const minWidthMm = Math.max(a.inlay?.minWidthMm ?? 0, b.inlay?.minWidthMm ?? 0);
  const widthMm = Math.max((4 * area) / (Math.PI * tubeHeight), minWidthMm);
  if (heightMm < minHeightMm - 1e-9) {
    failures.push(
      boxLimited
        ? {
            code: 'box-too-shallow',
            message: `Insufficient connector height: box too shallow (${label}): ${Math.max(0, availableMm).toFixed(2)} mm between the box floor and the marginal ridge, ${minHeightMm} mm required.`,
            valueMm: heightMm,
            limitMm: minHeightMm,
          }
        : {
            code: 'insufficient-height',
            message: `Insufficient connector height (${label}): ${Math.max(0, availableMm).toFixed(2)} mm available, ${minHeightMm} mm required.`,
            valueMm: heightMm,
            limitMm: minHeightMm,
          },
    );
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
  const samples = endSamples(polygon);
  /** Signed clearance of an end cap at t on the line (unit on the `sign` side), `sink` deep in its unit. */
  const clearanceAt = (unit: ConnectorUnit, sign: 1 | -1, t: number, sink: number) =>
    endClearance(add(centre, scale(direction, t)), scale(direction, -sign), sink, samples, widthDir, axis, unit.inner, unit.wing ? unit.solid : undefined);
  const end = (unit: ConnectorUnit, sign: 1 | -1): { t: number; surface: number } => {
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
    const clearance = (sink: number) => clearanceAt(unit, sign, surface + sign * sink, sink);
    // Distances change by at most the distance moved, so sinking by (clearance at the surface − the required
    // clearance) keeps it; step back where the sampled end disagrees.
    const c0 = clearance(0);
    const required = fitClearanceOf(unit);
    // A wing end must also stay clear of the tooth beside the wing (the end samples outside it).
    const clearsTooth = (sink: number) => {
      if (!unit.wing) return true;
      const cap = add(centre, scale(direction, surface + sign * sink));
      const back = scale(direction, -sign);
      return samples.every(([x, y, d]) => {
        const p = add(cap, add(add(scale(widthDir, x), scale(axis, y)), scale(back, d * sink)));
        if (insideAny([unit.solid], p, axis)) return true;
        const c = pointToothClearance(p, input.jaw, axis, unit.wing!.cementGapMm + 1);
        return c.mm >= unit.wing!.cementGapMm && !c.swept;
      });
    };
    let sink = Math.min(unit.wing?.maxSinkMm ?? CONNECTOR_MAX_SINK_MM, c0 - required);
    while (sink > MIN_SINK_MM && (clearance(sink) < required - FIT_CLEARANCE_TOLERANCE_MM || !clearsTooth(sink))) sink -= SINK_STEP_MM;
    // A wall too thin for the clearance: overlap the unit by MIN_SINK_MM, or by half the distance to the fitting
    // surface when that is less, so the end never reaches it (the clearance check below fails).
    if (sink < MIN_SINK_MM) sink = Math.max(0, Math.min(MIN_SINK_MM, c0 / 2));
    return { t: surface + sign * sink, surface };
  };
  const ea = end(a, -1);
  const eb = end(b, 1);
  let [tA, tB] = [ea.t, eb.t];
  if (tB - tA < 2 * MIN_SINK_MM) {
    const mid = (tA + tB) / 2;
    [tA, tB] = [mid - MIN_SINK_MM, mid + MIN_SINK_MM];
  }
  // The final ends: their depth and clearance; closer than CONNECTOR_FIT_CLEARANCE_MM to a fitting surface fails.
  const finalEnd = (unit: ConnectorUnit, sign: 1 | -1, t: number, surface: number): ConnectorEnd => {
    const sinkMm = sign * (t - surface);
    const fitClearanceMm = clearanceAt(unit, sign, t, Math.max(0, sinkMm));
    const required = fitClearanceOf(unit);
    if (fitClearanceMm < required - FIT_CLEARANCE_TOLERANCE_MM) {
      failures.push({
        code: 'fit-clearance',
        message: `Connector ${label}: its end in ${unit.fdi} is ${fitClearanceMm < 0 ? 'through' : `${fitClearanceMm.toFixed(2)} mm from`} the fitting surface (at least ${required} mm); the wall there is too thin for a connector.`,
        valueMm: fitClearanceMm,
        limitMm: required,
      });
    }
    return { fdi: unit.fdi, point: add(centre, scale(direction, t)), sinkMm, fitClearanceMm };
  };
  const ends: [ConnectorEnd, ConnectorEnd] = [finalEnd(a, -1, tA, ea.surface), finalEnd(b, 1, tB, eb.surface)];

  // Connectors to a Maryland wing: clear of the natural tooth, outside the wing.
  let tooth: ToothClearance | undefined;
  const wings = [a, b].filter((u) => u.wing);
  if (wings.length > 0) {
    const gapMm = Math.max(...wings.map((u) => u.wing!.cementGapMm));
    tooth = toothClearance({ centre, direction, widthDir, axis, polygon, span: [tA, tB], jaw: input.jaw, inside: wings.map((u) => u.solid), gapMm });
    if (tooth.clashSamples > 0) {
      const where = tooth.sweptSamples > 0 && tooth.minMm >= gapMm ? 'along the insertion path' : tooth.minMm < 0 ? `${(-tooth.minMm).toFixed(2)} mm deep` : `${tooth.minMm.toFixed(3)} mm from it`;
      failures.push({
        code: 'tooth-clash',
        message: `Connector ${label} clashes with the abutment (${where}; at least ${gapMm} mm outside the wing): move it or make it smaller.`,
        valueMm: tooth.minMm,
        limitMm: gapMm,
      });
    }
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
    ends,
    ...(tooth ? { toothClearance: tooth } : {}),
    failures,
    warnings,
  };
}

/** Clearance of a connector to the natural tooth next to a Maryland wing. */
export interface ToothClearance {
  /** Tube surface points tested (outside the wing). */
  samples: number;
  /**
   * Smallest clearance to the jaw scan: the distance to the closest scan point, negative (minus the depth along the
   * axis) for points inside the tooth; capped at the search distance (1 mm beyond the gap).
   */
  minMm: number;
  /** Points closer than the cement gap, inside the tooth, or with tooth structure ahead along the insertion path. */
  clashSamples: number;
  /** Of those: points outside the tooth that meet it when the bridge is inserted (moving along −axis onto the tooth). */
  sweptSamples: number;
}

/** A point is inside one of the closed solids (an odd number of crossings along `dir`). */
const insideAny = (solids: RayCaster[], p: V3, dir: V3): boolean => solids.some((solid) => solid.all(p, dir, 60).length % 2 === 1);

/**
 * Clearance of a point to the jaw scan: the closest-point distance (capped at `reach`), or minus the depth along
 * +axis when the point is inside the tooth (the first hit along +axis is a back face); `swept` when the tooth is
 * ahead of it along +axis (the bridge seats along −axis, so the point passes there on the way in).
 */
function pointToothClearance(p: V3, jaw: RayCaster, axis: V3, reach: number): { mm: number; swept: boolean } {
  const ahead = jaw.first(p, axis, 60);
  if (ahead && dot(ahead.normal, axis) > 0) return { mm: -ahead.distance, swept: false };
  const closest = jaw.closestPoint(p, reach);
  return { mm: closest ? closest.distance : reach, swept: Boolean(ahead) };
}

/** Stations along the tube for the tooth clearance, mm apart. */
const TOOTH_SAMPLE_STEP_MM = 0.1;

/**
 * Tooth clearance of a connector next to a wing. Points on the tube surface
 * (side wall at stations TOOTH_SAMPLE_STEP_MM apart, and both caps) that lie
 * inside a wing solid are skipped: there the connector is part of the wing.
 * Every other point must be at least `gapMm` from the jaw scan, and nothing of
 * the jaw may lie ahead of it along +axis: the bridge seats moving along
 * −axis, so the connector sweeps the space above (in +axis) its final place.
 * A ray along +axis tells both: a back-facing first hit means the point is
 * inside the tooth, a front-facing one that the tooth is in the way.
 */
function toothClearance(input: {
  centre: V3;
  direction: V3;
  widthDir: V3;
  axis: V3;
  polygon: Array<[number, number]>;
  span: [number, number];
  jaw: RayCaster;
  inside: RayCaster[];
  gapMm: number;
}): ToothClearance {
  const { centre, direction, widthDir, axis, polygon, span, jaw, gapMm } = input;
  const reach = gapMm + 1;
  let samples = 0, clash = 0, swept = 0, min = reach;
  const test = (p: V3) => {
    if (insideAny(input.inside, p, axis)) return;
    samples++;
    const c = pointToothClearance(p, jaw, axis, reach);
    min = Math.min(min, c.mm);
    if (c.mm < gapMm) clash++;
    else if (c.swept) {
      clash++;
      swept++;
    }
  };
  const [t0, t1] = span;
  const stations = Math.max(2, Math.ceil((t1 - t0) / TOOTH_SAMPLE_STEP_MM) + 1);
  const at = (t: number, x: number, y: number): V3 => add(centre, add(scale(direction, t), add(scale(widthDir, x), scale(axis, y))));
  for (let k = 0; k < stations; k++) {
    const t = t0 + ((t1 - t0) * k) / (stations - 1);
    for (const [x, y] of polygon) test(at(t, x, y));
  }
  for (const t of [t0, t1]) {
    test(at(t, 0, 0));
    for (const f of [1 / 3, 2 / 3]) for (const [x, y] of polygon) test(at(t, f * x, f * y));
  }
  return { samples, minMm: min, clashSamples: clash, sweptSamples: swept };
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
