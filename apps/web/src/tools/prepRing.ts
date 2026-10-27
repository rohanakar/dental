import { type DesignDocument, isImplantRestoration, jawOf } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import { prepFor, type PrepFinding } from '../geometry/prepFinder';
import { sceneController } from '../state/sceneController';
import { analysis } from '../workers/geometryClient';
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
const findings = new Map<string, PrepFinding | 'pending' | null>();
let onFound: (() => void) | null = null;

/** Called once a finding arrives, so the ring can be drawn (the controller re-syncs). */
export function onPrepsFound(callback: () => void): void {
  onFound = callback;
}

const crownPrep = (setup: DesignDocument['setup'], fdi: number): boolean => {
  const restoration = setup.teeth.find((t) => t.fdi === fdi)?.restoration;
  return Boolean(restoration && PREP_MARGIN.includes(restoration));
};

export interface JawFinding {
  finding: PrepFinding;
  jawSha: string;
  antagonistSha?: string;
  /** The case's crown-prep teeth on this jaw (paired with the preps) and its implant teeth (with the scan bodies). */
  preps: number[];
  implants: number[];
}

/**
 * The finding on one loaded jaw scan (its antagonist as context), with the case teeth it pairs
 * (specs/2026-10-26-auto-frames-jaws-implants.md): 'pending' while the worker computes it (the first request per scan
 * starts it), null when the jaw is not loaded, has no crown-prep or implant tooth, or the finder failed.
 */
export function jawFinding(jaw: 'upper' | 'lower'): JawFinding | 'pending' | null {
  const { setup } = useDesignStore.getState().doc;
  const scan = sceneController.geometryFor(jaw);
  const antagonist = sceneController.geometryFor(jaw === 'upper' ? 'lower' : 'upper');
  const onJaw = setup.teeth.filter((t) => jawOf(t.fdi) === jaw);
  const preps = onJaw.filter((t) => crownPrep(setup, t.fdi)).map((t) => t.fdi);
  const implants = onJaw.filter((t) => isImplantRestoration(t.restoration)).map((t) => t.fdi);
  if (!scan || preps.length + implants.length === 0) return null;
  const key = `${scan.sha256}:${antagonist?.sha256 ?? ''}`;
  if (!findings.has(key)) {
    findings.set(key, 'pending');
    analysis
      .findPreps(scan.sha256, antagonist?.sha256)
      .then((finding) => findings.set(key, finding))
      // No ring and no frames from the finding: the Tooth frame step works as before.
      .catch(() => findings.set(key, null))
      .finally(() => onFound?.());
  }
  const finding = findings.get(key)!;
  if (!finding || finding === 'pending') return finding;
  return { finding, jawSha: scan.sha256, ...(antagonist ? { antagonistSha: antagonist.sha256 } : {}), preps, implants };
}

/**
 * The finding on the active tooth's jaw, for a crown-prep tooth, with the case's crown-prep teeth on that jaw (the
 * teeth the preps are paired with).
 */
export function activeFinding(): { finding: PrepFinding; fdi: number; teeth: number[] } | null {
  const { doc, activeFdi } = useDesignStore.getState();
  if (!doc.teeth.some((t) => t.fdi === activeFdi) || !crownPrep(doc.setup, activeFdi)) return null;
  const found = jawFinding(jawOf(activeFdi));
  return found && found !== 'pending' ? { finding: found.finding, fdi: activeFdi, teeth: found.preps } : null;
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
  const near = (top: V3) => Math.hypot(top[0] - point[0]!, top[1] - point[1]!, top[2] - point[2]!) <= FAR_FROM_PREP_MM;
  if (!active.finding.preps.some((p) => near(p.top))) {
    return { kind: 'warning', text: `That doesn't look like a prepared tooth. If it is not the prep of ${active.fdi}, click the prep to redo the frame.` };
  }
  // The prep the case pairs with another of its teeth: the frame would put this tooth where Case setup put that one.
  const other = active.teeth.find((f) => f !== active.fdi && ((top) => top !== undefined && near(top))(prepFor(active.finding, f, active.teeth)?.top));
  if (other === undefined) return null;
  return { kind: 'warning', text: `That is the prep of ${other}, not ${active.fdi}. The frame is set on ${active.fdi}; click the prep of ${active.fdi} to redo it.` };
}
