import type { Cutback, DesignParams } from '@dcad/shared';
import type { CrownDesign, CrownFrame } from '../geometry/crown';
import { templateForTooth } from '../geometry/crownTemplate';
import { frameworkForUnit, veneerMap, type UnitFramework, type UnitOverpress } from '../geometry/framework';
import { overpressSolid, type OverpressResult } from '../geometry/overpress';
import type { FrameworkView, OverpressView } from './frameworkTypes';

/**
 * Worker side of framework units: the transferable views of a framework and an overpress part. Arrays of results
 * that live on in the bridge cache are copied; the copies (and fresh arrays) are listed in `transfer`.
 */

const out = <T extends Float32Array | Uint32Array>(array: T, transfer: ArrayBuffer[], copy: boolean): T => {
  const a = copy ? (array.slice() as T) : array;
  transfer.push(a.buffer as ArrayBuffer);
  return a;
};

export function frameworkView(f: UnitFramework, transfer: ArrayBuffer[], copy: boolean): FrameworkView {
  const r = f.report;
  return {
    cutback: f.cutback,
    positions: out(f.mesh.positions, transfer, copy),
    veneer: out(veneerMap(f), transfer, false),
    stats: r.veneer,
    ...(r.shortfall ? { shortfall: r.shortfall } : {}),
    ...(r.protection ? { protection: r.protection } : {}),
    validation: r.validation,
    projectedVertices: r.projectedVertices,
    repairedFaces: r.repairedFaces,
    warnings: r.warnings,
  };
}

export function overpressView(fdi: number, o: OverpressResult, transfer: ArrayBuffer[]): OverpressView {
  return {
    fdi,
    positions: out(o.mesh.positions, transfer, false),
    indices: out(o.mesh.indices, transfer, false),
    validation: o.validation,
    volumeMm3: o.volumeMm3,
    components: o.components,
    dropped: o.dropped,
  };
}

export const overpressViews = (parts: readonly UnitOverpress[], transfer: ArrayBuffer[]): OverpressView[] =>
  parts.map((p) => overpressView(p.fdi, p.result, transfer));

/**
 * A single reduced crown: cut back the designed crown, and with `overpress` (the boolean engine must be loaded) make
 * its overpress part. Call before the crown's own buffers are transferred.
 */
export function singleFramework(input: {
  fdi: number;
  design: CrownDesign;
  frame: CrownFrame;
  cutback: Cutback;
  params: DesignParams;
  overpress: boolean;
  transfer: ArrayBuffer[];
}): FrameworkView {
  const f = frameworkForUnit({ design: input.design, template: templateForTooth(input.fdi), frame: input.frame, kind: 'abutment', cutback: input.cutback, params: input.params });
  const view = frameworkView(f, input.transfer, false);
  if (input.overpress && input.cutback.overpress) view.overpress = overpressView(input.fdi, overpressSolid(input.design.mesh, f.mesh), input.transfer);
  return view;
}
