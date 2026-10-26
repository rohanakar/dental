import { proposeMarginAnchors } from './autoMargin';
import { marginFromAnchors, type EdgeWeight } from './livewire';
import { ringConsistentAnchors, smoothOnSurface } from './marginRefine';
import { MARGIN_LENGTH_MM, MARGIN_MAX_TURN_DEG, MARGIN_MAX_WANDER, turnsDeg } from './marginShape';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';

/**
 * Margin tools (specs/2026-10-26-margin-ai.md): the operations a model may use to repair an automatic margin. Each is
 * a deterministic computation on the scan: the model chooses which and where, never coordinates of its own. The same
 * functions back the in-app assistant and the headless evaluation harness.
 */

export interface MarginScan {
  positions: Float32Array;
  indices: Uint32Array;
  ray: RayCaster;
  graph: SurfaceGraph;
  weight: EdgeWeight;
  frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3 };
}

/** A margin being repaired: its anchors (in order round the prep) and the closed line traced through them. */
export interface MarginWork {
  anchors: V3[];
  points: V3[];
  lengthMm: number;
  /** Profiles run for the anchors' last automatic proposal (for the "found all round" share). */
  profilesRun: number;
  /** Anchors that profile found an edge for. */
  found: number;
}

export type Side = 'mesial' | 'distal' | 'buccal' | 'lingual' | 'mesiobuccal' | 'distobuccal' | 'mesiolingual' | 'distolingual';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const flat = (points: Float32Array): V3[] => Array.from({ length: points.length / 3 }, (_, i) => [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!]);

/** The side of the tooth a point lies on, from the frame (eight sectors of 45°). */
export function sideOf(scan: MarginScan, p: V3): Side {
  const d = sub(p, scan.frame.origin);
  const angle = (Math.atan2(dot(d, scan.frame.buccal), dot(d, scan.frame.mesial)) * 180) / Math.PI;
  const sectors: Side[] = ['mesial', 'mesiobuccal', 'buccal', 'distobuccal', 'distal', 'distolingual', 'lingual', 'mesiolingual'];
  return sectors[((Math.round(angle / 45) % 8) + 8) % 8]!;
}

/** Re-trace the closed line through the anchors with the live-wire. */
export function retrace(scan: MarginScan, work: Omit<MarginWork, 'points' | 'lengthMm'>): MarginWork {
  const trace = marginFromAnchors({ positions: scan.positions, indices: scan.indices, graph: scan.graph, weight: scan.weight, ray: scan.ray, anchors: work.anchors });
  return { ...work, points: flat(trace.points), lengthMm: trace.lengthMm };
}

export interface MarginReport {
  passes: boolean;
  lengthMm: number;
  sharpestTurnDeg: number;
  wander: number;
  foundShare: number;
  /** Where the line turns sharper than the gate allows, by side, with the nearest anchor. */
  kinks: Array<{ side: Side; turnDeg: number; nearestAnchor: number }>;
  anchors: Array<{ index: number; side: Side; heightMm: number; radiusMm: number }>;
  /** Plain-language reasons the gate fails (empty when it passes). */
  problems: string[];
}

export function marginReport(scan: MarginScan, work: MarginWork): MarginReport {
  const o = scan.frame.occlusal;
  const top = dot(scan.frame.origin, o);
  const turns = turnsDeg(work.points);
  const perimeter = work.anchors.reduce((s, a, i) => s + Math.hypot(...sub(work.anchors[(i + 1) % work.anchors.length]!, a)), 0);
  const wander = work.lengthMm / Math.max(perimeter, 1e-6);
  const foundShare = work.found / work.profilesRun;
  const nearest = (p: V3) => work.anchors.reduce((best, a, i) => (Math.hypot(...sub(a, p)) < Math.hypot(...sub(work.anchors[best]!, p)) ? i : best), 0);
  const kinks: MarginReport['kinks'] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]! <= MARGIN_MAX_TURN_DEG) continue;
    const side = sideOf(scan, work.points[i]!);
    const anchor = nearest(work.points[i]!);
    const prior = kinks.find((k) => k.side === side && k.nearestAnchor === anchor);
    if (prior) prior.turnDeg = Math.max(prior.turnDeg, turns[i]!);
    else kinks.push({ side, turnDeg: Math.round(turns[i]!), nearestAnchor: anchor });
  }
  const sharpestTurnDeg = Math.round(turns.reduce((m, t) => Math.max(m, t), 0));
  const problems = [
    ...(work.lengthMm < MARGIN_LENGTH_MM[0] || work.lengthMm > MARGIN_LENGTH_MM[1] ? [`length ${work.lengthMm.toFixed(1)} mm is outside ${MARGIN_LENGTH_MM[0]}–${MARGIN_LENGTH_MM[1]} mm`] : []),
    ...(sharpestTurnDeg > MARGIN_MAX_TURN_DEG ? [`the line doubles back (sharpest turn ${sharpestTurnDeg}°, at most ${MARGIN_MAX_TURN_DEG}°)`] : []),
    ...(wander > MARGIN_MAX_WANDER ? [`the line detours away from its anchors (wander ${wander.toFixed(2)}, at most ${MARGIN_MAX_WANDER})`] : []),
    ...(foundShare < 0.75 ? [`the edge was found on only ${Math.round(foundShare * 100)}% of the way round`] : []),
  ];
  return {
    passes: problems.length === 0,
    lengthMm: Number(work.lengthMm.toFixed(2)),
    sharpestTurnDeg,
    wander: Number(wander.toFixed(3)),
    foundShare: Number(foundShare.toFixed(2)),
    kinks,
    anchors: work.anchors.map((a, index) => ({
      index,
      side: sideOf(scan, a),
      heightMm: Number((dot(a, o) - top).toFixed(2)),
      radiusMm: Number(Math.hypot(dot(sub(a, scan.frame.origin), scan.frame.mesial), dot(sub(a, scan.frame.origin), scan.frame.buccal)).toFixed(2)),
    })),
    problems,
  };
}

/** Run the automatic margin again with other settings. */
export function rerunAutoMargin(scan: MarginScan, opts: { profiles: number; ringFilter: boolean; smooth: boolean }): MarginWork {
  const profiles = Math.max(8, Math.min(64, Math.round(opts.profiles)));
  const proposal = proposeMarginAnchors({ positions: scan.positions, indices: scan.indices, ray: scan.ray, frame: scan.frame, count: profiles });
  const anchors = opts.ringFilter ? ringConsistentAnchors(proposal.anchors, proposal.profiles) : proposal.anchors;
  if (anchors.length < 3) throw new Error('No margin edge found around the prep: check that the tooth is prepared');
  const work = retrace(scan, { anchors, profilesRun: profiles, found: proposal.anchors.length });
  return opts.smooth ? smoothWork(scan, work) : work;
}

export function removeAnchor(scan: MarginScan, work: MarginWork, index: number): MarginWork {
  if (work.anchors.length <= 4) throw new Error('A margin needs at least 4 anchors');
  if (index < 0 || index >= work.anchors.length) throw new Error(`No anchor ${index}`);
  return retrace(scan, { ...work, anchors: work.anchors.filter((_, i) => i !== index) });
}

/**
 * A new anchor between anchors `after` and `after + 1`: on the radial profile through their midpoint's angle, at the
 * strongest convex edge (the finish line) within the profile's search, as the automatic margin finds it.
 */
export function addAnchor(scan: MarginScan, work: MarginWork, after: number): MarginWork {
  const n = work.anchors.length;
  if (after < 0 || after >= n) throw new Error(`No anchor ${after}`);
  const a = work.anchors[after]!, b = work.anchors[(after + 1) % n]!;
  const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const d = sub(mid, scan.frame.origin);
  const angle = Math.atan2(dot(d, scan.frame.buccal), dot(d, scan.frame.mesial));
  // One profile at that angle: proposeMarginAnchors with a frame rotated so its first profile points there.
  const c = Math.cos(angle), s = Math.sin(angle);
  const m = scan.frame.mesial, bu = scan.frame.buccal;
  const mesial: V3 = [c * m[0] + s * bu[0], c * m[1] + s * bu[1], c * m[2] + s * bu[2]];
  const proposal = proposeMarginAnchors({ positions: scan.positions, indices: scan.indices, ray: scan.ray, frame: { origin: scan.frame.origin, occlusal: scan.frame.occlusal, mesial }, count: 1 });
  const p = proposal.anchors[0];
  if (!p) throw new Error('No margin edge on that side: the profile found no finish line');
  const anchors = [...work.anchors.slice(0, after + 1), p, ...work.anchors.slice(after + 1)];
  return retrace(scan, { ...work, anchors, found: work.found + 1, profilesRun: work.profilesRun + 1 });
}

/** Move an anchor by `mm` toward the gingiva or the occlusal surface (along the frame), then back onto the scan. */
export function moveAnchor(scan: MarginScan, work: MarginWork, index: number, toward: 'gingival' | 'occlusal' | 'outward' | 'inward', mm: number): MarginWork {
  const p = work.anchors[index];
  if (!p) throw new Error(`No anchor ${index}`);
  const step = Math.max(-1, Math.min(1, mm));
  const o = scan.frame.occlusal;
  const radial = sub(p, scan.frame.origin);
  const h = dot(radial, o);
  const flatR: V3 = [radial[0] - h * o[0], radial[1] - h * o[1], radial[2] - h * o[2]];
  const len = Math.hypot(...flatR) || 1;
  const dir: V3 = toward === 'gingival' ? [-o[0], -o[1], -o[2]] : toward === 'occlusal' ? o : toward === 'outward' ? [flatR[0] / len, flatR[1] / len, flatR[2] / len] : [-flatR[0] / len, -flatR[1] / len, -flatR[2] / len];
  const target: V3 = [p[0] + dir[0] * step, p[1] + dir[1] * step, p[2] + dir[2] * step];
  const hit = scan.ray.closestPoint(target, 2);
  if (!hit) throw new Error('No scan surface there');
  const anchors = work.anchors.map((a, i) => (i === index ? ([hit.point[0], hit.point[1], hit.point[2]] as V3) : a));
  return retrace(scan, { ...work, anchors });
}

/** Smooth the traced line over a few tenths of a millimetre and put it back on the scan. */
export function smoothWork(scan: MarginScan, work: MarginWork, windowMm = 0.4): MarginWork {
  const packed = new Float32Array(work.points.flat());
  const points = flat(smoothOnSurface(packed, scan.ray, Math.max(0.2, Math.min(1, windowMm))));
  let lengthMm = 0;
  for (let i = 0; i < points.length; i++) lengthMm += Math.hypot(...sub(points[(i + 1) % points.length]!, points[i]!));
  return { ...work, points, lengthMm };
}
