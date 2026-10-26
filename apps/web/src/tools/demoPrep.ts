import { jawOf } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import { DEMO_SCAN, SYNTHETIC_PREP_FDI, syntheticPrepSeed } from '../geometry/synthetic';
import { useSessionStore } from '../state/session';
import type { V3 } from './toolStore';

/** The ring around the demo prep, and how far from its top a first click may land (mm). */
export const DEMO_PREP_RADIUS_MM = 4.5;
const DEMO_CLICK_MM = 5.5;

let seed: V3 | null = null;

/**
 * The top of the demo case's prep while the demo's own scan is the active tooth's jaw, else null. The demo scan is
 * synthetic, so the app knows which tooth a first-time user has to click; a real scan has no such answer.
 */
export function demoPrep(): V3 | null {
  const { doc, activeFdi } = useDesignStore.getState();
  if (!useSessionStore.getState().demo || activeFdi !== SYNTHETIC_PREP_FDI) return null;
  const jaw = jawOf(activeFdi);
  if (doc.scans.find((s) => s.role === jaw)?.name !== `demo-${jaw}.ply`) return null;
  seed ??= syntheticPrepSeed({ along: DEMO_SCAN.lower.along });
  return seed;
}

/** Whether a first click in the demo missed the prep (it would design the wrong tooth). */
export function missesDemoPrep(point: readonly number[]): boolean {
  const prep = demoPrep();
  return Boolean(prep && Math.hypot(point[0]! - prep[0], point[1]! - prep[1], point[2]! - prep[2]) > DEMO_CLICK_MM);
}

/** A ring of `radius` around `centre` in the plane normal to `up`, as a closed polyline. */
export function ringPoints(centre: V3, up: readonly number[], radius: number, n = 48): V3[] {
  const u = Math.hypot(up[0]!, up[1]!, up[2]!) || 1;
  const z: V3 = [up[0]! / u, up[1]! / u, up[2]! / u];
  const a: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x: V3 = [z[1] * a[2] - z[2] * a[1], z[2] * a[0] - z[0] * a[2], z[0] * a[1] - z[1] * a[0]];
  const xl = Math.hypot(...x);
  const e1: V3 = [x[0] / xl, x[1] / xl, x[2] / xl];
  const e2: V3 = [z[1] * e1[2] - z[2] * e1[1], z[2] * e1[0] - z[0] * e1[2], z[0] * e1[1] - z[1] * e1[0]];
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    const c = Math.cos(t) * radius;
    const s = Math.sin(t) * radius;
    return [centre[0] + c * e1[0] + s * e2[0], centre[1] + c * e1[1] + s * e2[1], centre[2] + c * e1[2] + s * e2[2]];
  });
}
