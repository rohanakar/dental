import type { QaCheck } from '@dcad/shared';
import { marginGate } from '../ai/qa';

type V3 = readonly [number, number, number];

/** Stride of the turn measure, as in `sharpestTurnDeg` (ai/qa.ts), which the margin gate uses. */
const STRIDE_MM = 0.6;
/** At most this many kinks are named and marked; more than that means the margin needs tracing again anyway. */
const MAX_KINKS = 5;

export interface MarginKink {
  /** The sharpest point of the kink. */
  point: V3;
  /** Its turn over the gate's stride (degrees). */
  turnDeg: number;
  /** Which side of the prep it is on, e.g. "mesiolabial" (null without a frame). */
  side: string | null;
}

export interface MarginProblems {
  lengthMm: number;
  /** The margin gate's checks that failed (length, no kinks). */
  failed: QaCheck[];
  /** Where the line turns more sharply than the gate allows, sharpest first. */
  kinks: MarginKink[];
}

/** Turn (degrees) at each point between chords spanning about `strideMm` before and after it (the sharpestTurnDeg rule). */
function turnsAt(points: ReadonlyArray<V3>, strideMm: number): Float64Array {
  const n = points.length;
  const turns = new Float64Array(n);
  if (n < 3) return turns;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const k = Math.max(1, Math.min(Math.floor(n / 4), Math.round(strideMm / (length / n))));
  for (let i = 0; i < n; i++) {
    const a = points[(i - k + n) % n]!, b = points[i]!, c = points[(i + k) % n]!;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const lu = Math.hypot(u[0]!, u[1]!, u[2]!), lv = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (lu < 1e-9 || lv < 1e-9) continue;
    const cos = (u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!) / (lu * lv);
    turns[i] = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  }
  return turns;
}

/** The side of the prep a point is on, from the tooth frame: "mesial", "distobuccal", "lingual"… (labial on front teeth). */
function sideOf(p: V3, centre: V3, frame: { mesial: readonly number[]; buccal: readonly number[] }, fdi: number): string {
  const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
  const md = d[0]! * frame.mesial[0]! + d[1]! * frame.mesial[1]! + d[2]! * frame.mesial[2]!;
  const bl = d[0]! * frame.buccal[0]! + d[1]! * frame.buccal[1]! + d[2]! * frame.buccal[2]!;
  const front = fdi % 10 <= 3;
  const mesioDistal = md >= 0 ? 'mesial' : 'distal';
  const buccoLingual = bl >= 0 ? (front ? 'labial' : 'buccal') : 'lingual';
  const ratio = Math.abs(md) / Math.max(1e-9, Math.abs(bl));
  if (ratio > 2) return mesioDistal;
  if (ratio < 0.5) return buccoLingual;
  return `${mesioDistal === 'mesial' ? 'mesio' : 'disto'}${buccoLingual}`;
}

/**
 * What is wrong with a closed margin before a crown is designed on it: the margin gate (`marginGate`, ai/qa.ts:
 * plausible length, no turn sharper than 120° over 0.6 mm), plus where each kink is, so it can be marked and named.
 * A kink is a run of points turning more sharply than the gate allows; it is reported at its sharpest point.
 */
export function marginProblems(
  points: ReadonlyArray<V3>,
  tooth?: { fdi: number; frame?: { mesial: readonly number[]; buccal: readonly number[] } },
): MarginProblems {
  const n = points.length;
  let lengthMm = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    lengthMm += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const gate = marginGate({ points, lengthMm });
  const failed = gate.filter((c) => !c.passed);
  const limit = gate.find((c) => c.id === 'margin.smooth')?.threshold;
  const kinks: MarginKink[] = [];
  if (limit !== undefined && failed.some((c) => c.id === 'margin.smooth')) {
    const turns = turnsAt(points, STRIDE_MM);
    const centre: V3 = [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k]!, 0) / n) as [number, number, number];
    const kinkAt = (i: number) => {
      const p = points[i]!;
      kinks.push({ point: p, turnDeg: turns[i]!, side: tooth?.frame ? sideOf(p, centre, tooth.frame, tooth.fdi) : null });
    };
    // Start the walk on a point below the limit, so a run that wraps around the start is not split in two.
    const start = turns.findIndex((t) => t <= limit);
    if (start < 0) kinkAt(turns.indexOf(Math.max(...turns)));
    let best = -1;
    for (let j = 0; start >= 0 && j <= n; j++) {
      const i = (start + j) % n;
      const over = j < n && turns[i]! > limit;
      if (over && (best < 0 || turns[i]! > turns[best]!)) best = i;
      if (!over && best >= 0) {
        kinkAt(best);
        best = -1;
      }
    }
    kinks.sort((a, b) => b.turnDeg - a.turnDeg);
  }
  return { lengthMm, failed, kinks: kinks.slice(0, MAX_KINKS) };
}
