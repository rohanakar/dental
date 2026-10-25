import type { BridgeConnectorResult, BridgeUnitInput, BridgeUnitResult } from './bridge';
import { measureConnector, type ConnectorFailure, type ConnectorMeasure } from './connectors';
import type { CrownInput } from './crown';
import { distanceFromMargin, measureIntaglioGap, type GapCheck } from './intaglio';
import type { IndexedMesh } from './mesh';
import { meshTopology, validateClosedMesh } from './meshValidate';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh } from './raycast';
import { countSelfIntersections } from './selfIntersect';

/**
 * Checks of a merged bridge (the union of its retainers, pontics and
 * connectors), all measured on the union itself:
 * - the solid: closed, consistently oriented, no self-intersections, one
 *   connected component of genus 0;
 * - connectors: the smallest section across each gap (measureConnector) is at
 *   least the designed area, its height at least the material minimum, and the
 *   design reported no failure;
 * - seating: the cement gap re-measured per retainer against the union
 *   matches the retainer's own within SEATING_TOLERANCE_MM, on the same
 *   number of samples (the union left the fitting surfaces untouched; a
 *   dropped sample means material in the cement space);
 * - pontic base: from the ridge up to the union, the smallest gap is within
 *   ponticRidgeGapMm − PONTIC_BASE_TOLERANCE_MM … + PONTIC_BASE_MAX_EXCESS_MM
 *   (and the mean gap is not below the lower bound): the base rests on the
 *   ridge at the target gap, neither in it nor floating above it.
 */

export const SEATING_TOLERANCE_MM = 0.005;
export const PONTIC_BASE_TOLERANCE_MM = 0.02;
/** The pontic base's smallest gap to the ridge may exceed ponticRidgeGapMm by at most this much. */
export const PONTIC_BASE_MAX_EXCESS_MM = 0.05;

export interface BridgeUnionCheck {
  triangles: number;
  vertices: number;
  volumeMm3: number;
  closed: boolean;
  oriented: boolean;
  degenerateTriangles: number;
  selfIntersections: number;
  /** Closed, oriented, positive volume, no degenerate triangles and no self-intersections. */
  printable: boolean;
  components: number;
  genus: number;
  euler: number;
  /** printable, one component, genus 0. */
  ok: boolean;
}

export interface ConnectorCheck {
  between: [number, number];
  /** The designed area (the check's target) and the material minimum. */
  targetAreaMm2: number;
  minAreaMm2: number;
  designedHeightMm: number;
  minHeightMm: number;
  measured: ConnectorMeasure;
  /** Failures reported by the connector design (insufficient height, too wide). */
  failures: ConnectorFailure[];
  areaOk: boolean;
  heightOk: boolean;
  ok: boolean;
}

export interface SeatingCheck {
  fdi: number;
  /** The retainer's own gap check, and the same measurement against the union. */
  own: GapCheck;
  onUnion: GapCheck;
  deltaMeanMm: number;
  deltaMaxMm: number;
  ok: boolean;
}

export interface PonticBaseCheck {
  fdi: number;
  samples: number;
  minGapMm: number;
  meanGapMm: number;
  targetMm: number;
  ok: boolean;
}

export interface BridgeChecks {
  union: BridgeUnionCheck;
  connectors: ConnectorCheck[];
  seating: SeatingCheck[];
  ponticBase: PonticBaseCheck[];
  /** One line per failed check. */
  failures: string[];
  ok: boolean;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/** Run every bridge check on a merged bridge; see the module comment. */
export function checkBridgeUnion(input: {
  union: IndexedMesh;
  jaw: CrownInput['jaw'];
  axis: V3;
  units: Array<{ input: BridgeUnitInput; result: BridgeUnitResult }>;
  connectors: BridgeConnectorResult[];
}): BridgeChecks {
  const { union, jaw, axis } = input;
  const failures: string[] = [];

  const v = validateClosedMesh(union);
  const selfIntersections = countSelfIntersections(union).count;
  const topology = meshTopology(union);
  const printable = v.ok && selfIntersections === 0;
  const solid: BridgeUnionCheck = {
    triangles: v.triangles,
    vertices: v.vertices,
    volumeMm3: v.signedVolumeMm3,
    closed: v.closed,
    oriented: v.oriented,
    degenerateTriangles: v.degenerateTriangles,
    selfIntersections,
    printable,
    components: topology.components,
    genus: topology.genus,
    euler: topology.euler,
    ok: printable && topology.components === 1 && topology.genus === 0,
  };
  if (!v.ok) failures.push(`The merged bridge is not a valid closed solid (${v.boundaryEdges} open, ${v.nonManifoldEdges} non-manifold edges, ${v.degenerateTriangles} degenerate triangles).`);
  if (selfIntersections > 0) failures.push(`The merged bridge intersects itself (${selfIntersections} triangle pairs).`);
  if (topology.components !== 1) failures.push(`The merged bridge has ${topology.components} separate parts; every unit must be connected.`);
  else if (topology.genus !== 0) failures.push(`The merged bridge has ${topology.genus} through-holes (genus ${topology.genus}).`);

  const connectors = input.connectors.map((c): ConnectorCheck => {
    const measured = measureConnector(union, c);
    const areaOk = measured.minAreaMm2 >= c.areaMm2;
    const heightOk = measured.heightMm >= c.minHeightMm && c.heightMm >= c.minHeightMm;
    const label = `${c.between[0]}–${c.between[1]}`;
    if (!areaOk) failures.push(`Connector ${label}: smallest section ${measured.minAreaMm2.toFixed(2)} mm² is below ${c.areaMm2} mm².`);
    if (!heightOk) failures.push(`Connector ${label}: height ${Math.min(measured.heightMm, c.heightMm).toFixed(2)} mm is below ${c.minHeightMm} mm.`);
    failures.push(...c.failures.map((f) => f.message));
    return {
      between: c.between,
      targetAreaMm2: c.areaMm2,
      minAreaMm2: c.minAreaMm2,
      designedHeightMm: c.heightMm,
      minHeightMm: c.minHeightMm,
      measured,
      failures: c.failures,
      areaOk,
      heightOk,
      ok: areaOk && heightOk && c.failures.length === 0,
    };
  });

  const unionRay = bvhRayCaster(createBvh({ positions: union.positions.slice(), indices: union.indices.slice() }));
  const seating: SeatingCheck[] = [];
  const ponticBase: PonticBaseCheck[] = [];
  for (const { input: u, result } of input.units) {
    const design = result.design;
    if (result.kind === 'abutment' && u.region) {
      const distance = distanceFromMargin(jaw.positions, jaw.graph, u.region.vertexMask, u.region.loopVertices);
      const onUnion = measureIntaglioGap({
        positions: jaw.positions,
        normals: jaw.smoothNormals,
        vertexMask: u.region.vertexMask,
        distance,
        axis,
        params: u.params,
        intaglio: unionRay,
      });
      const deltaMeanMm = Math.abs(onUnion.meanErrorMm - design.gapCheck.meanErrorMm);
      const deltaMaxMm = Math.abs(onUnion.maxErrorMm - design.gapCheck.maxErrorMm);
      const ok =
        onUnion.samples > 0 && onUnion.samples === design.gapCheck.samples && deltaMeanMm <= SEATING_TOLERANCE_MM && deltaMaxMm <= SEATING_TOLERANCE_MM;
      if (!ok) {
        failures.push(
          `Retainer ${result.fdi}: the seating changed in the union (mean ${(deltaMeanMm * 1000).toFixed(1)} µm, max ${(deltaMaxMm * 1000).toFixed(1)} µm, ` +
            `${onUnion.samples} of ${design.gapCheck.samples} gap samples).`,
        );
      }
      seating.push({ fdi: result.fdi, own: design.gapCheck, onUnion, deltaMeanMm, deltaMaxMm, ok });
    }
    if (result.kind === 'pontic') {
      // From the ridge under each base vertex up to the union.
      const target = u.params.ponticRidgeGapMm;
      const down = scale(axis, -1);
      let samples = 0, sum = 0, min = Infinity;
      for (let i = 0; i < design.intaglioVertices; i++) {
        const p: V3 = [design.mesh.positions[i * 3]!, design.mesh.positions[i * 3 + 1]!, design.mesh.positions[i * 3 + 2]!];
        const ridge = jaw.ray.first(add(p, scale(axis, 3)), down, 10);
        if (!ridge) continue;
        const hit = unionRay.first(add(ridge.point, down), axis, 10);
        if (!hit) continue;
        const gap = hit.distance - 1;
        samples++;
        sum += gap;
        min = Math.min(min, gap);
      }
      const meanGapMm = samples ? sum / samples : Number.NaN;
      const minGapMm = samples ? min : Number.NaN;
      const ok =
        samples > 0 &&
        minGapMm >= target - PONTIC_BASE_TOLERANCE_MM &&
        minGapMm <= target + PONTIC_BASE_MAX_EXCESS_MM &&
        meanGapMm >= target - PONTIC_BASE_TOLERANCE_MM;
      if (!ok) {
        failures.push(
          `Pontic ${result.fdi}: the base is ${Number.isFinite(minGapMm) ? `${minGapMm.toFixed(3)} mm` : 'not measured'} from the ridge ` +
            `(target ${target} mm, −${PONTIC_BASE_TOLERANCE_MM}/+${PONTIC_BASE_MAX_EXCESS_MM} mm).`,
        );
      }
      ponticBase.push({ fdi: result.fdi, samples, minGapMm, meanGapMm, targetMm: target, ok });
    }
  }

  return {
    union: solid,
    connectors,
    seating,
    ponticBase,
    failures,
    ok: solid.ok && connectors.every((c) => c.ok) && seating.every((s) => s.ok) && ponticBase.every((p) => p.ok),
  };
}
