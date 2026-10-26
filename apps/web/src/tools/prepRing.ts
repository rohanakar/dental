import { jawOf } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import { prepFor, type PrepFinding } from '../geometry/prepFinder';
import { analysis } from '../workers/geometryClient';
import { toothContext } from './context';
import { demoPrep } from './demoPrep';
import { PREP_MARGIN } from './marginView';
import type { ToolState, V3 } from './toolStore';

/**
 * The ring around the active tooth's prep on the Tooth frame step, on any scan (specs/2026-10-26-prep-finder.md).
 * The demo keeps its known prep (demoPrep.ts). Other scans get the prep found by the worker (geometry/prepFinder.ts),
 * paired with the tooth in arch order. Only restorations on a crown prep (PREP_MARGIN) get one.
 */

/** A first click this far (mm) from every prep found on the jaw gets the warning. */
const FAR_FROM_PREP_MM = 6;

/** The worker's finding per jaw scan and antagonist; null while it is computed (or after it failed). */
const findings = new Map<string, PrepFinding | null>();
let onFound: (() => void) | null = null;

/** Called once a finding arrives, so the ring can be drawn (the controller re-syncs). */
export function onPrepsFound(callback: () => void): void {
  onFound = callback;
}

/** The finding on the active tooth's jaw, for a crown-prep tooth; the first request per scan starts the worker. */
function activeFinding(): { finding: PrepFinding; fdi: number; teeth: number[] } | null {
  const ctx = toothContext();
  const { setup } = useDesignStore.getState().doc;
  const crownPrep = (fdi: number) => {
    const restoration = setup.teeth.find((t) => t.fdi === fdi)?.restoration;
    return Boolean(restoration && PREP_MARGIN.includes(restoration));
  };
  if (!ctx || !crownPrep(ctx.fdi)) return null;
  const key = `${ctx.jaw.sha256}:${ctx.antagonist?.sha256 ?? ''}`;
  if (!findings.has(key)) {
    findings.set(key, null);
    analysis
      .findPreps(ctx.jaw.sha256, ctx.antagonist?.sha256)
      .then((finding) => {
        findings.set(key, finding);
        onFound?.();
      })
      .catch(() => {
        // No ring: the Tooth frame step works as before.
      });
  }
  const finding = findings.get(key);
  if (!finding) return null;
  const teeth = setup.teeth.filter((t) => jawOf(t.fdi) === jawOf(ctx.fdi) && crownPrep(t.fdi)).map((t) => t.fdi);
  return { finding, fdi: ctx.fdi, teeth };
}

/** The top of the prep to ring for the active tooth: the demo's, else the one found on its scan; null if none. */
export function prepRing(): V3 | null {
  const demo = demoPrep();
  if (demo) return demo;
  const active = activeFinding();
  return active ? (prepFor(active.finding, active.fdi, active.teeth)?.top ?? null) : null;
}

/**
 * The status-line warning for a first click well away from every prep found on the jaw. Never a refusal: the
 * finding can miss a prep. Null in the demo (its click guard refuses such a click), before the finding arrives,
 * when it found no prep, and for restorations without a crown prep.
 */
export function prepWarning(point: readonly number[]): ToolState['message'] {
  if (demoPrep()) return null;
  const active = activeFinding();
  if (!active || active.finding.preps.length === 0) return null;
  const near = active.finding.preps.some((p) => Math.hypot(p.top[0] - point[0]!, p.top[1] - point[1]!, p.top[2] - point[2]!) <= FAR_FROM_PREP_MM);
  if (near) return null;
  return { kind: 'warning', text: `That doesn't look like a prepared tooth. If it is not the prep of ${active.fdi}, click the prep to redo the frame.` };
}
