import { archIndex, type CrownAdapt, type Pose, type ProximalSide, type UnitKind } from '@dcad/shared';
import type { ArchCurve } from './arch';
import type { CrownDesign, CrownFrame, CrownInput } from './crown';
import type { CrownMapName } from './crownMaps';
import { templateForTooth, type CrownTemplate } from './crownTemplate';
import { implantBasis, implantToWorld, type ImplantPose } from './implantLibrary';
import { designImplantCrown, gingivalOpening, proposeImplantCrownPose, restorationMeshOf, type ImplantCrownDesign, type ImplantUnit } from './implantCrown';
import type { GapCheck } from './intaglio';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import { measureTiBaseGap, type TiBaseGapCheck } from './tiBase';
import { SEATING_TOLERANCE_MM, type SeatingCheck } from './bridgeUnion';

/**
 * Implant units in bridges (specs/2026-10-25-implant-bridges.md): the common insertion path over the implant axes
 * with the divergence check, the retainer hook designBridge calls for implant units, the units' widths from the
 * implant spacing along the arch, and the seating on each Ti-base re-measured on the union.
 */

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const angleDeg = (a: V3, b: V3) => (Math.acos(Math.min(1, Math.max(-1, dot(normalize(a), normalize(b))))) * 180) / Math.PI;

// ---- Common path ------------------------------------------------------------------------

export interface ImplantPathResult {
  /** The insertion path: the direction that minimizes the largest angle to any implant axis. */
  direction: V3;
  /** Largest angle between two implant axes, and the library limit it is checked against. */
  divergenceDeg: number;
  maxDivergenceDeg: number;
  ok: boolean;
  implants: Array<{ fdi: number; angleToPathDeg: number }>;
  failures: string[];
}

/**
 * One insertion path for the implant units of a bridge: the centre of the smallest cone around their axes (each
 * Ti-base is then off the path by at most half the largest divergence, and the undercut blockout on the Ti-bases is
 * smallest). Fails when two implants diverge by more than the library's maxDivergenceDeg.
 */
export function searchImplantPath(implants: Array<{ fdi: number; axis: V3; maxDivergenceDeg: number }>): ImplantPathResult {
  if (implants.length === 0) throw new Error('An implant path needs at least one implant');
  const axes = implants.map((i) => normalize(i.axis));
  let mean: V3 = [0, 0, 0];
  for (const a of axes) mean = add(mean, a);
  mean = normalize(mean);
  // Minimax over a tangent-plane grid around the mean, refined twice.
  const [u, v] = ((): [V3, V3] => {
    const e = normalize(cross(Math.abs(mean[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], mean));
    return [e, cross(mean, e)];
  })();
  const worst = (d: V3) => Math.max(...axes.map((a) => angleDeg(a, d)));
  let best = mean, bestCost = worst(mean);
  let span = Math.max(1e-3, Math.tan((bestCost * Math.PI) / 180));
  let centre: [number, number] = [0, 0];
  for (let round = 0; round < 4; round++) {
    const n = 20;
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const a = centre[0] + (span * i) / n, b = centre[1] + (span * j) / n;
        const d = normalize(add(mean, add(scale(u, a), scale(v, b))));
        const c = worst(d);
        if (c < bestCost) [best, bestCost] = [d, c];
      }
    }
    centre = [dot(best, u) / dot(best, mean), dot(best, v) / dot(best, mean)];
    span /= 8;
  }
  let divergenceDeg = 0;
  for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++) divergenceDeg = Math.max(divergenceDeg, angleDeg(axes[i]!, axes[j]!));
  const maxDivergenceDeg = Math.min(...implants.map((i) => i.maxDivergenceDeg));
  const ok = divergenceDeg <= maxDivergenceDeg + 1e-9;
  return {
    direction: best,
    divergenceDeg,
    maxDivergenceDeg,
    ok,
    implants: implants.map((i, k) => ({ fdi: i.fdi, angleToPathDeg: angleDeg(axes[k]!, best) })),
    failures: ok ? [] : [`The implants diverge by ${divergenceDeg.toFixed(1)}°, over the Ti-base library's ${maxDivergenceDeg}°: they cannot share one insertion path.`],
  };
}

// ---- Widths from the implant spacing -------------------------------------------------------------

/**
 * Mesio-distal widths of a bridge's implant crowns from the implant spacing: between two implant units, the arch
 * length between their implants is shared out in proportion to the nominal (template) widths of the units between
 * and including them (half of each end unit). An implant unit takes its nominal width times the mean ratio over its
 * implant neighbours; units without one get none (they are sized from the contacts).
 */
export function implantUnitWidths(curve: ArchCurve, units: Array<{ fdi: number; kind: UnitKind; implantCentre?: V3 }>): Map<number, number> {
  const ordered = [...units].sort((a, b) => archIndex(a.fdi) - archIndex(b.fdi));
  const nominal = (fdi: number) => templateForTooth(fdi).size.md;
  const out = new Map<number, number>();
  ordered.forEach((u, i) => {
    if (!u.implantCentre) return;
    const ratios: number[] = [];
    for (const dir of [-1, 1]) {
      let between = 0;
      for (let k = i + dir; k >= 0 && k < ordered.length; k += dir) {
        const w = ordered[k]!;
        if (w.implantCentre) {
          const arch = Math.abs(curve.project(w.implantCentre) - curve.project(u.implantCentre));
          const sum = nominal(u.fdi) / 2 + between + nominal(w.fdi) / 2;
          if (arch > 0 && sum > 0) ratios.push(arch / sum);
          break;
        }
        between += nominal(w.fdi);
      }
    }
    if (ratios.length) out.set(u.fdi, nominal(u.fdi) * Math.min(1.4, Math.max(0.55, ratios.reduce((a, b) => a + b, 0) / ratios.length)));
  });
  return out;
}

// ---- The designBridge hook ---------------------------------------------------------------------

/** What designBridge needs from an implant retainer: its frame, proposal, cache key and design. */
export interface ImplantRetainer {
  frame: CrownFrame;
  proposal: { pose: Pose; warnings: string[] } | null;
  key: unknown[];
  design: () => CrownDesign;
}

/**
 * An implant unit of a bridge, for designBridge: contacts and adaptation only on free sides, its width from the
 * implant spacing (implantUnitWidths), the common path as the insertion axis, the channel cut before the union.
 */
export function implantRetainer(input: {
  fdi: number;
  implant: ImplantUnit;
  frame: CrownFrame;
  params: CrownInput['params'];
  pose?: Pose;
  adapt?: CrownAdapt;
  template?: CrownTemplate;
  sides: ProximalSide[];
  jaw: CrownInput['jaw'];
  antagonist?: RayCaster;
  axis: V3;
  widths: Map<number, number>;
  maps?: CrownMapName[];
}): ImplantRetainer {
  const { fdi, implant, sides, jaw } = input;
  const { mesialContact, distalContact, ...rest } = input.frame;
  const frame: CrownFrame = {
    ...rest,
    ...(mesialContact && !sides.includes('mesial') ? { mesialContact } : {}),
    ...(distalContact && !sides.includes('distal') ? { distalContact } : {}),
  };
  let adapt: CrownAdapt | undefined;
  if (input.adapt) {
    adapt = { ...input.adapt };
    for (const side of sides) delete adapt[side];
  }
  const template = input.template ?? templateForTooth(fdi);
  const opening = gingivalOpening({ positions: jaw.positions, entry: implant.entry, pose: implant.pose });
  const mdMm = input.widths.get(fdi);
  const proposal = input.pose ? null : proposeImplantCrownPose({ template, frame, opening, mdMm, antagonist: input.antagonist, params: input.params });
  const pose = input.pose ?? proposal!.pose;
  return {
    frame,
    proposal,
    key: [fdi, input.params, frame, implant.entry.key, implant.pose, implant.channel ?? null, pose, adapt ?? null, template.id],
    design: () =>
      designImplantCrown({
        fdi,
        jaw,
        antagonist: input.antagonist,
        frame,
        implant,
        axis: input.axis,
        params: input.params,
        pose,
        template: input.template,
        maps: input.maps,
        adapt,
        opening,
      }),
  };
}

/** The mesh of a unit in the bridge union: implant crowns contribute their restoration with the screw channel. */
export const unionMeshOf = restorationMeshOf;

/** Implant units whose screw channel was cut: each is one through-hole of the merged bridge. */
export const channelCount = (designs: readonly CrownDesign[]): number => designs.filter((d) => (d as Partial<ImplantCrownDesign>).implant?.cut).length;

// ---- Seating on the union -----------------------------------------------------------------------

const asGapCheck = (g: TiBaseGapCheck): GapCheck => ({ samples: g.tiBaseSamples, meanErrorMm: g.meanErrorMm, maxErrorMm: g.maxErrorMm });

/**
 * The bonding gap on a unit's Ti-base, measured against its own restoration and against the merged bridge, away from
 * the screw channel (its hole has no intaglio). The union must leave it unchanged.
 */
export function implantSeating(input: { design: CrownDesign; implant: ImplantUnit; union: IndexedMesh; gapMm: number }): { own: GapCheck; onUnion: GapCheck } | null {
  const extras = (input.design as Partial<ImplantCrownDesign>).implant;
  if (!extras) return null;
  const { pose, entry } = input.implant;
  const channel = extras.channel;
  const clear = channel.radiusMm + 0.3;
  // Samples near the channel axis are left out: through the channel there is nothing to measure against.
  const exclude = (p: V3) => {
    const d = sub(p, channel.pivot);
    const along = dot(d, channel.direction);
    return Math.hypot(...sub(d, scale(channel.direction, along))) < clear;
  };
  const tiBase = { positions: placed(entry.tiBase.positions, pose), indices: entry.tiBase.indices };
  const own = measureTiBaseGap({ tiBase, intaglio: restorationMeshOf(input.design), rim: extras.rim, pose, gapMm: input.gapMm, exclude, intaglioSide: false });
  const onUnion = measureTiBaseGap({ tiBase, intaglio: input.union, rim: extras.rim, pose, gapMm: input.gapMm, exclude, intaglioSide: false });
  return { own: asGapCheck(own), onUnion: asGapCheck(onUnion) };
}

/** implantSeating as a bridge check: unchanged within SEATING_TOLERANCE_MM, on the same number of samples. */
export function implantSeatingCheck(input: { fdi: number; design: CrownDesign; implant: ImplantUnit; union: IndexedMesh }): { check: SeatingCheck; ok: boolean; failure: string } | null {
  const extras = (input.design as Partial<ImplantCrownDesign>).implant;
  if (!extras) return null;
  const measured = implantSeating({ design: input.design, implant: input.implant, union: input.union, gapMm: extras.gapMm });
  if (!measured) return null;
  const { own, onUnion } = measured;
  const deltaMeanMm = Math.abs(onUnion.meanErrorMm - own.meanErrorMm);
  const deltaMaxMm = Math.abs(onUnion.maxErrorMm - own.maxErrorMm);
  const ok = onUnion.samples > 0 && onUnion.samples === own.samples && deltaMeanMm <= SEATING_TOLERANCE_MM && deltaMaxMm <= SEATING_TOLERANCE_MM;
  return {
    check: { fdi: input.fdi, own, onUnion, deltaMeanMm, deltaMaxMm, ok },
    ok,
    failure: `Implant crown ${input.fdi}: the seating on its Ti-base changed in the union (mean ${(deltaMeanMm * 1000).toFixed(1)} µm, max ${(deltaMaxMm * 1000).toFixed(1)} µm, ${onUnion.samples} of ${own.samples} gap samples).`,
  };
}

function placed(positions: Float32Array, pose: ImplantPose): Float32Array {
  const f = implantToWorld(pose);
  const out = new Float32Array(positions.length);
  for (let i = 0; i < out.length; i += 3) out.set(f([positions[i]!, positions[i + 1]!, positions[i + 2]!]), i);
  return out;
}

/** The implant axis of a unit (library +z at its pose). */
export const implantAxisOf = (pose: ImplantPose): V3 => implantBasis(pose).z;

