import type { MarginLineKind } from './livewire';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';

/**
 * Where a margin line is doubtful, from the scan alone (specs/2026-10-27-margin-review-ux.md; the rule of the natural-
 * margin research's UX study, specs/research/2026-10-27-natural-margin/ux.md). Across the line at each sample, the
 * scan's profile is marched ±1.5 mm. The line is "on" when it sits on the crease it should follow (concave for a
 * natural tooth's gum line, convex for a prep's finish line), "weak" when it is not on a clear crease but there is
 * no stronger one nearby, and "off" when a clearly stronger crease lies more than 0.25 mm across it. Off stretches
 * become the parts to look at, worst first. It orders the stops of a review; it does not replace one.
 */

export interface MarginDoubtInput {
  positions: Float32Array;
  indices: Uint32Array;
  /** Unit vertex normals. */
  normals: Float32Array;
  ray: RayCaster;
  /** Toward the occlusal (the tooth frame's occlusal direction). */
  up: V3;
  /** The closed margin line, in order. */
  points: V3[];
  line: MarginLineKind;
}

export const DOUBT_ON = 0;
export const DOUBT_WEAK = 1;
export const DOUBT_OFF = 2;

export interface DoubtPart {
  /** The middle of the stretch (on the line). */
  at: V3;
  /** Where the stronger crease is, across the line (mm; + toward the occlusal). */
  offsetMm: number;
  lengthMm: number;
}

export interface MarginDoubt {
  /** Per input point: DOUBT_ON, DOUBT_WEAK or DOUBT_OFF. */
  levels: Uint8Array;
  /** The off stretches, worst first. */
  parts: DoubtPart[];
}

/** Sample spacing along the line, the profile's reach and step, and the curvature stride (mm). */
const SAMPLE_MM = 0.5;
const REACH_MM = 1.5;
const STEP_MM = 0.05;
const CURVATURE_MM = 0.15;
/** A crease this strong (1/mm) counts. */
const ON_CREASE = 0.15;
/**
 * "Off": a crease this much stronger than the line's own, more than this far across it (mm). Measured
 * (tools/pipeline-runner/src/natural/doubtCheck.ts): on real gum lines with a fifth pushed 1 mm up, 87% of the wrong
 * points are flagged at 92% precision, and 1% of right lines. A prep's finish line has convex line angles nearby, so
 * it needs a stricter rule: on the synthetic preps 36% of a pushed fifth is flagged at 69% precision, and 7% of
 * right lines.
 */
const OFF: Record<MarginLineKind, { offMm: number; stronger: number }> = {
  gum: { offMm: 0.25, stronger: 1.3 },
  finish: { offMm: 0.35, stronger: 1.6 },
};

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => mul(a, 1 / (Math.hypot(...a) || 1));

export function marginDoubt(input: MarginDoubtInput): MarginDoubt {
  const { points, ray } = input;
  const n = points.length;
  const levels = new Uint8Array(n);
  if (n < 8) return { levels, parts: [] };
  // In a valley the neighbours sit toward the normal, so the second difference points along it: + for a gum line.
  const sign = input.line === 'gum' ? 1 : -1;

  const project = (p: V3): V3 => {
    const hit = ray.closestPoint(p, 1);
    return hit ? [hit.point[0], hit.point[1], hit.point[2]] : p;
  };
  const normalAt = (p: V3): V3 => {
    const hit = ray.closestPoint(p, 1);
    if (!hit || hit.faceIndex < 0) return input.up;
    let s: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = input.indices[hit.faceIndex * 3 + k]!;
      s = add(s, [input.normals[v * 3]!, input.normals[v * 3 + 1]!, input.normals[v * 3 + 2]!]);
    }
    return unit(s);
  };

  // Samples about SAMPLE_MM apart along the line.
  const along: number[] = [0];
  for (let i = 1; i <= n; i++) along.push(along[i - 1]! + Math.hypot(...sub(points[i % n]!, points[i - 1]!)));
  const total = along[n]!;
  const count = Math.max(8, Math.round(total / SAMPLE_MM));
  const samples: number[] = [];
  for (let k = 0, i = 0; k < count; k++) {
    const target = (k * total) / count;
    while (i < n - 1 && along[i + 1]! <= target) i++;
    samples.push(i);
  }

  const kSteps = Math.max(1, Math.round(CURVATURE_MM / STEP_MM));
  const reachSteps = Math.round(REACH_MM / STEP_MM);
  const results = samples.map((i) => {
    const p = points[i]!;
    // Tangent over about ±0.3 mm.
    let j0 = i, j1 = i;
    for (let walked = 0; walked < 0.3; ) { const j = (j0 - 1 + n) % n; walked += Math.hypot(...sub(points[j0]!, points[j]!)); j0 = j; if (j0 === i) break; }
    for (let walked = 0; walked < 0.3; ) { const j = (j1 + 1) % n; walked += Math.hypot(...sub(points[j]!, points[j1]!)); j1 = j; if (j1 === i) break; }
    const t = unit(sub(points[j1]!, points[j0]!));
    // March across the line on the scan, toward the occlusal (+) and away from it (−).
    const march = (dir: number) => {
      const out: Array<{ q: V3; normal: V3 }> = [];
      let q = p, prev: V3 | null = null;
      for (let s = 0; s < reachSteps; s++) {
        const normal = normalAt(q);
        let u = unit(cross(t, normal));
        if (prev ? dot(u, prev) < 0 : dot(u, input.up) < 0) u = mul(u, -1);
        prev = u;
        q = project(add(q, mul(u, dir * STEP_MM)));
        out.push({ q, normal });
      }
      return out;
    };
    const upward = march(1), downward = march(-1);
    const profile = [...downward.reverse(), { q: p, normal: normalAt(p) }, ...upward];
    const centre = downward.length;
    // Crease strength along the profile: the second difference across ±CURVATURE_MM against the normal, signed so
    // the crease this line follows is positive.
    const crease = profile.map((x, s) => {
      if (s < kSteps || s + kSteps >= profile.length) return 0;
      const second = sub(add(profile[s - kSteps]!.q, profile[s + kSteps]!.q), mul(x.q, 2));
      return (sign * dot(second, x.normal)) / (kSteps * STEP_MM) ** 2;
    });
    const here = Math.max(...crease.slice(Math.max(0, centre - 1), centre + 2));
    let best = centre;
    for (let s = 0; s < crease.length; s++) if (crease[s]! > crease[best]!) best = s;
    const offsetMm = (best - centre) * STEP_MM;
    const { offMm, stronger } = OFF[input.line];
    const off = crease[best]! >= ON_CREASE && Math.abs(offsetMm) > offMm && crease[best]! > stronger * Math.max(here, 0);
    return { level: off ? DOUBT_OFF : here < ON_CREASE ? DOUBT_WEAK : DOUBT_ON, offsetMm };
  });

  // A lone sample does not make a stretch: the median of three along the line.
  const raw = results.map((r) => r.level);
  const smoothed = raw.map((_, k) => [raw[(k - 1 + count) % count]!, raw[k]!, raw[(k + 1) % count]!].sort()[1]!);

  // Each point takes its sample's level.
  for (let k = 0; k < count; k++) {
    const from = samples[k]!, to = k + 1 < count ? samples[k + 1]! : n;
    for (let i = from; i < to; i++) levels[i] = smoothed[k]!;
  }

  // Off stretches (cyclic runs of off samples), worst (longest × furthest) first.
  const parts: DoubtPart[] = [];
  const startAt = smoothed.findIndex((l) => l !== DOUBT_OFF);
  if (startAt < 0) {
    parts.push({ at: points[0]!, offsetMm: median(results.map((r) => r.offsetMm)), lengthMm: total });
  } else {
    let run: number[] = [];
    for (let j = 0; j <= count; j++) {
      const k = (startAt + j) % count;
      if (j < count && smoothed[k] === DOUBT_OFF) run.push(k);
      else if (run.length) {
        parts.push({ at: points[samples[run[Math.floor(run.length / 2)]!]!]!, offsetMm: median(run.map((r) => results[r]!.offsetMm)), lengthMm: run.length * (total / count) });
        run = [];
      }
    }
  }
  parts.sort((a, b) => b.lengthMm * Math.abs(b.offsetMm) - a.lengthMm * Math.abs(a.offsetMm));
  return { levels, parts };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}
