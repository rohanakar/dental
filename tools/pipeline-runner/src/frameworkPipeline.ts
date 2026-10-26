import { CUTBACK_DEFAULTS, isReduced, type Cutback, type RestorationType } from '@dcad/shared';
import { bridgeReassembly, writeBinaryStl, type BridgeResult, type IndexedMesh } from '@dcad/web/geometry';
import type { GoldenCase } from './golden';
import { round } from './pipeline';

/**
 * The framework variant of a bridge case (specs/2026-10-25-framework-bridges.md): reduced units are cut back in
 * designBridge, the union is the framework bridge, and each reduced unit with overpress gets its overpress part.
 */

/** Veneer space below the requested thickness outside the shortfall, beyond this, fails (the spec's tolerance). */
export const MIN_OFFSET_WITHIN_TOLERANCE = 0.99;
/** Framework ∪ overpress against the anatomy, two-sided Hausdorff (mm). */
export const MAX_REASSEMBLY_MM = 0.05;
/** Framework thickness below its profile, after protection (mm). */
export const FRAMEWORK_THICKNESS_TOLERANCE_MM = 0.02;

/** The cutback of a unit of the case: undefined for anatomic units. */
export function caseCutback(spec: GoldenCase, restoration: RestorationType): Cutback | undefined {
  return isReduced(restoration) ? (spec.bridge?.cutback ?? CUTBACK_DEFAULTS) : undefined;
}

export interface FrameworkUnitMetrics {
  fdi: number;
  cutback: Cutback;
  framework: { triangles: number; volumeMm3: number; closed: boolean; printable: boolean; selfIntersections: number };
  veneer: {
    vertices: number;
    minMm: number;
    meanMm: number;
    maxMm: number;
    withinTolerance: number;
    thinVertices: number;
    thickVertices: number;
    thickAreaMm2: number;
    offsetVertices: number;
    offsetWithinTolerance: number;
    maxAnywhereMm: number;
  };
  shortfall?: { vertices: number; areaMm2: number; minVeneerMm: number; maxDeficitMm: number };
  protection?: { retractedVertices: number; pushedVertices: number; maxPushMm: number; minSlackMm: number };
  projectedVertices: number;
  repairedFaces: number;
  overpress?: { triangles: number; volumeMm3: number; components: number; printable: boolean; droppedComponents: number };
  warnings: string[];
}

export interface FrameworkMetrics {
  units: FrameworkUnitMetrics[];
  reassembly?: { hausdorffMm: number; anatomyToPartsMm: number; partsToAnatomyMm: number; extraShells: number; closed: boolean };
}

type Check = (id: string, passed: boolean, message: string, value?: number, threshold?: number) => void;

/**
 * Metrics and checks of the reduced units: each framework is a printable solid at least its minimum thick, its veneer
 * never thinner than requested outside the reported shortfall (and the requested thickness ± 0.05 mm where it is
 * offset), each overpress part a printable solid, and framework ∪ overpress gives back the anatomy. Shortfalls are
 * reported, never failed: the synthetic preps' axial walls are thinner than a veneered crown needs.
 */
export function frameworkChecks(result: BridgeResult, check: Check): { metrics: FrameworkMetrics; overpressStls: Array<{ fdi: number; stl: Uint8Array }> } | null {
  const reduced = result.units.filter((u) => u.framework);
  if (reduced.length === 0) return null;
  const units = reduced.map((u): FrameworkUnitMetrics => {
    const f = u.framework!;
    const r = f.report;
    const v = r.validation;
    check(`framework.printable.${u.fdi}`, v.printable, `${u.fdi}: the framework is a closed solid without self-intersections`, v.selfIntersections, 0);
    check(`framework.veneerThin.${u.fdi}`, r.veneer.thinVertices === 0, `${u.fdi}: no veneer thinner than requested outside the reported shortfall (vertices)`, r.veneer.thinVertices, 0);
    check(
      `framework.veneerOffset.${u.fdi}`,
      !(r.veneer.offsetWithinTolerance < MIN_OFFSET_WITHIN_TOLERANCE),
      `${u.fdi}: veneer space within ${f.cutback.thicknessMm} ± 0.05 mm where the surface is offset (fraction)`,
      r.veneer.offsetWithinTolerance,
      MIN_OFFSET_WITHIN_TOLERANCE,
    );
    if (r.protection) {
      check(
        `framework.thickness.${u.fdi}`,
        r.protection.minSlackMm >= -FRAMEWORK_THICKNESS_TOLERANCE_MM,
        `${u.fdi}: the framework is at least its minimum thickness (worst thickness − profile, mm)`,
        r.protection.minSlackMm,
        -FRAMEWORK_THICKNESS_TOLERANCE_MM,
      );
    }
    const o = result.overpress?.find((x) => x.fdi === u.fdi)?.result;
    if (f.cutback.overpress) {
      check(`overpress.printable.${u.fdi}`, Boolean(o?.validation.printable), `${u.fdi}: the overpress part is a closed solid without self-intersections`);
    }
    return {
      fdi: u.fdi,
      cutback: f.cutback,
      framework: { triangles: v.triangles, volumeMm3: round(v.signedVolumeMm3, 2), closed: v.closed, printable: v.printable, selfIntersections: v.selfIntersections },
      veneer: {
        vertices: r.veneer.vertices,
        minMm: round(r.veneer.minMm),
        meanMm: round(r.veneer.meanMm),
        maxMm: round(r.veneer.maxMm),
        withinTolerance: round(r.veneer.withinTolerance),
        thinVertices: r.veneer.thinVertices,
        thickVertices: r.veneer.thickVertices,
        thickAreaMm2: round(r.veneer.thickAreaMm2, 2),
        offsetVertices: r.veneer.offsetVertices,
        offsetWithinTolerance: round(r.veneer.offsetWithinTolerance),
        maxAnywhereMm: round(r.veneer.maxAnywhereMm),
      },
      ...(r.shortfall
        ? { shortfall: { vertices: r.shortfall.vertices, areaMm2: round(r.shortfall.areaMm2, 2), minVeneerMm: round(r.shortfall.minVeneerMm), maxDeficitMm: round(r.shortfall.maxDeficitMm) } }
        : {}),
      ...(r.protection ? { protection: { ...r.protection, maxPushMm: round(r.protection.maxPushMm), minSlackMm: round(r.protection.minSlackMm) } } : {}),
      projectedVertices: r.projectedVertices,
      repairedFaces: r.repairedFaces,
      ...(o
        ? {
            overpress: {
              triangles: o.validation.triangles,
              volumeMm3: round(o.volumeMm3, 2),
              components: o.components,
              printable: o.validation.printable,
              droppedComponents: o.dropped.components,
            },
          }
        : {}),
      warnings: r.warnings,
    };
  });

  let reassembly: FrameworkMetrics['reassembly'];
  const overpress = result.overpress ?? [];
  if (result.union && overpress.length > 0) {
    const re = bridgeReassembly(result.units, result.union.mesh, overpress);
    check('framework.reassembly', re.hausdorffMm <= MAX_REASSEMBLY_MM, 'Framework ∪ overpress against the anatomy: Hausdorff distance on the outer surfaces (mm)', re.hausdorffMm, MAX_REASSEMBLY_MM);
    reassembly = {
      hausdorffMm: round(re.hausdorffMm, 5),
      anatomyToPartsMm: round(re.anatomyToPartsMm, 5),
      partsToAnatomyMm: round(re.partsToAnatomyMm, 5),
      extraShells: re.extraShells.count,
      closed: re.closed,
    };
  }
  const overpressStls = overpress.map((o) => ({ fdi: o.fdi, stl: writeBinaryStl(o.result.mesh as IndexedMesh) }));
  return { metrics: { units, ...(reassembly ? { reassembly } : {}) }, overpressStls };
}
