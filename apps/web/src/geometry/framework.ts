import type { Cutback, DesignParams, ProximalSide, UnitKind } from '@dcad/shared';
import type { BridgeCache, BridgeUnitInput, BridgeUnitResult, UnitWork } from './bridge';
import type { CrownDesign, CrownFrame } from './crown';
import { templateForTooth, type CrownTemplate } from './crownTemplate';
import { cutBack, unitCutbackSurface, type CutbackResult } from './cutback';
import type { IndexedMesh } from './mesh';
import { unionMeshes } from './meshBoolean';
import { checkReassembly, overpressSolid, type OverpressResult, type ReassemblyCheck } from './overpress';
import { bvhRayCaster, createBvh } from './raycast';

/**
 * Framework units (specs/2026-10-25-framework-bridges.md): a reduced crown or
 * pontic is designed as the full anatomy (designCrown / designPontic), then
 * cut back (cutback.ts). The framework keeps the anatomy's vertices and faces,
 * so the fitting surface, the margin band and a pontic's ridge base are those
 * of the anatomy. In a bridge the connectors attach to the frameworks and the
 * union is the framework bridge (bridge.ts hooks below); the overpress of a
 * unit is its anatomy minus the framework union.
 */

/** A reduced unit: its framework and the cutback report. The unit's design keeps the anatomy. */
export interface UnitFramework {
  /** The framework: the anatomy's vertices and faces, the outer surface cut back. A closed solid. */
  mesh: IndexedMesh;
  /** The cutback it was made with. */
  cutback: Cutback;
  /** cutBack's report: veneer space per outer vertex and its statistics, the shortfall, protection, validation. */
  report: Omit<CutbackResult, 'mesh'>;
  /** First outer vertex (the anatomy's shellStart): report arrays are indexed from it. */
  shellStart: number;
}

/** The overpress of one reduced unit with `cutback.overpress`: its anatomy minus the framework (bridge: the union). */
export interface UnitOverpress {
  fdi: number;
  result: OverpressResult;
}

/**
 * A bridge unit's proximal side toward a connected unit stays at full contour where the connector joins it: the
 * connector is sized for the units' contours, and the framework wall there would be too thin to take its end (the
 * porcelain covers the joint from buccal and lingual). The band: normals within 37° of the side's direction (the
 * proximal face proper; a wider cone leaves only a strip of the buccal face to veneer), between these height fractions.
 */
export const CONNECTOR_JOINT_MIN_DOT = 0.8;
export const CONNECTOR_JOINT_HEIGHT: [number, number] = [0.1, 0.9];

/** Cut back one designed unit. The framework minimum is the unit's minThicknessMm (a crown's protection). */
export function frameworkForUnit(input: {
  design: Pick<CrownDesign, 'mesh' | 'shellStart' | 'intaglioVertices'>;
  template: CrownTemplate;
  frame: CrownFrame;
  kind: UnitKind;
  cutback: Cutback;
  params: Pick<DesignParams, 'marginThicknessMm' | 'minThicknessMm'>;
  /** Bridge units: sides with a connector (kept at full contour around the joint). */
  connectedSides?: readonly ProximalSide[];
}): UnitFramework {
  const base = unitCutbackSurface({ design: input.design, template: input.template, frame: input.frame, fitting: input.kind === 'abutment' });
  const mesial = input.frame.mesial;
  const keepFacing = (input.connectedSides ?? []).map((side) => ({
    direction: (side === 'mesial' ? mesial : [-mesial[0], -mesial[1], -mesial[2]]) as [number, number, number],
    minDot: CONNECTOR_JOINT_MIN_DOT,
    heightFraction: CONNECTOR_JOINT_HEIGHT,
  }));
  const surface = keepFacing.length ? { ...base, keepFacing } : base;
  const { mesh, ...report } = cutBack(surface, input.cutback, {
    marginThicknessMm: input.params.marginThicknessMm,
    minThicknessMm: input.params.minThicknessMm,
  });
  return { mesh, cutback: input.cutback, report, shellStart: input.design.shellStart };
}

/**
 * Veneer space per vertex of the unit mesh (mm): measured on the full cutback (where the statistics and the shortfall
 * count it), NaN elsewhere. The taper to the collar is thinner than requested by design, so it is left uncoloured.
 */
export function veneerMap(framework: UnitFramework): Float32Array {
  const n = framework.mesh.positions.length / 3;
  const out = new Float32Array(n).fill(Number.NaN);
  const { veneerMm, veneerCounted } = framework.report;
  for (let i = 0; i < veneerMm.length; i++) if (veneerCounted[i]) out[framework.shellStart + i] = veneerMm[i]!;
  return out;
}

/**
 * Bridge hook (designBridge, after the units are designed and the pontics laid out): replace each reduced unit's work
 * by its framework, cached by the unit's key and the cutback. The connectors and the union then use the framework
 * (its mesh, ray caster and key); the unit's design keeps the anatomy for the display and the overpress.
 */
export function applyFrameworks(work: Map<number, UnitWork>, units: readonly BridgeUnitInput[], cache: BridgeCache | undefined, warnings: string[]): void {
  for (const u of units) {
    const w = work.get(u.fdi);
    if (!u.cutback || !w) continue;
    const sides = w.result.connectedSides;
    const key = `${w.key}|framework:${JSON.stringify(u.cutback)}:${sides.join(',')}`;
    let hit = cache?.get<{ framework: UnitFramework; solid: UnitWork['solid'] }>(key);
    if (!hit) {
      try {
        const framework = frameworkForUnit({
          design: w.result.design,
          template: u.template ?? templateForTooth(u.fdi),
          frame: w.result.frame,
          kind: u.kind,
          cutback: u.cutback,
          params: u.params,
          connectedSides: sides,
        });
        hit = { framework, solid: bvhRayCaster(createBvh({ positions: framework.mesh.positions.slice(), indices: framework.mesh.indices.slice() })) };
        cache?.set(key, hit);
      } catch (error) {
        warnings.push(`${u.fdi}: the cutback failed (${(error as Error).message}); the unit stays anatomic.`);
        continue;
      }
    }
    warnings.push(...hit.framework.report.warnings.map((m) => `${u.fdi}: ${m}`));
    work.set(u.fdi, { ...w, key, solid: hit.solid, result: { ...w.result, framework: hit.framework } });
  }
}

/** The mesh a unit contributes to the bridge: its framework when it is reduced, else its design. */
export const assemblyMesh = (unit: Pick<BridgeUnitResult, 'design' | 'framework'>): IndexedMesh => unit.framework?.mesh ?? unit.design.mesh;

/**
 * Bridge hook (after the union): the overpress of every reduced unit with `cutback.overpress`, its anatomy minus its
 * framework and minus the connectors, so no overpress overlaps a connector. (Not minus the union: the union is
 * re-meshed, so its collar no longer coincides with the anatomy's and the difference leaves slivers along it.) Needs
 * the boolean engine.
 */
export function bridgeOverpress(units: readonly BridgeUnitResult[], connectors: readonly IndexedMesh[], warnings: string[]): UnitOverpress[] {
  const out: UnitOverpress[] = [];
  const reduced = units.filter((u) => u.framework?.cutback.overpress);
  if (reduced.length === 0) return out;
  const joints = connectors.length > 1 ? unionMeshes([...connectors]) : connectors[0];
  for (const u of reduced) {
    try {
      const result = overpressSolid(u.design.mesh, u.framework!.mesh, joints ? { subtract: joints } : {});
      if (!result.validation.printable) warnings.push(`${u.fdi}: the overpress part is not a printable solid.`);
      out.push({ fdi: u.fdi, result });
    } catch (error) {
      warnings.push(`${u.fdi}: the overpress could not be made (${(error as Error).message}).`);
    }
  }
  return out;
}

/**
 * Does the bridge come back from its parts? The anatomic units together with the framework union (whose connectors
 * lie between them) against the framework union plus every overpress part: two-sided Hausdorff on the outer surfaces.
 */
export function bridgeReassembly(units: readonly BridgeUnitResult[], frameworkUnion: IndexedMesh, overpress: readonly UnitOverpress[]): ReassemblyCheck {
  const anatomy = unionMeshes([...units.map((u) => u.design.mesh), frameworkUnion]);
  const parts = overpress.filter((o) => o.result.mesh.indices.length > 0).map((o) => o.result.mesh);
  const overpressUnion = parts.length > 1 ? unionMeshes(parts) : (parts[0] ?? { positions: new Float32Array(0), indices: new Uint32Array(0) });
  return checkReassembly(anatomy, frameworkUnion, overpressUnion);
}
