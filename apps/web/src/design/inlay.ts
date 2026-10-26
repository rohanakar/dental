import { type CommandOf, type DesignDocument, isCavityRestoration, outerSourceOf, type RestorationType, type ScanRef, type StepId, type StepStatus, type ToothDesign } from '@dcad/shared';
import { CommandError } from './reducer';

/**
 * Inlays and onlays in the document (specs/2026-10-25-inlay-bridges.md): the cavity margin is not a crown prep's
 * margin (nor a wing outline), and the outer surface comes from the pre-op scan or the library tooth
 * (ToothDesign.outerSource). A library inlay keeps its fitted pose in the crown record, so move, rotate and scale
 * adjust the fitted tooth; a pre-op inlay follows the scan and has nothing to move.
 */

type Steps = Record<StepId, StepStatus>;

/** The retainer family of a restoration: switching between families redoes the margin (its meaning changes). */
export const retainerFamily = (restoration: RestorationType): 'wing' | 'cavity' | 'crown' =>
  restoration === 'maryland-wing' ? 'wing' : isCavityRestoration(restoration) ? 'cavity' : 'crown';

export const isCavityTooth = (doc: Pick<DesignDocument, 'setup'>, fdi: number): boolean => {
  const order = doc.setup.teeth.find((t) => t.fdi === fdi);
  return Boolean(order && isCavityRestoration(order.restoration));
};

/** The proposal is redone: the crown record (the fitted pose, or the pre-op placeholder) goes. */
function redoProposal(tooth: ToothDesign, markStaleFrom: (steps: Steps, step: StepId) => Steps): ToothDesign {
  const { crown: _crown, ...rest } = tooth;
  return { ...rest, steps: { ...markStaleFrom(tooth.steps, 'proposal'), proposal: 'pending' } };
}

/** setOuterSource: only for inlays and onlays; a change of source redoes the proposal. */
export function setOuterSource(doc: DesignDocument, cmd: CommandOf<'setOuterSource'>, markStaleFrom: (steps: Steps, step: StepId) => Steps): DesignDocument {
  if (!doc.teeth.some((t) => t.fdi === cmd.fdi)) throw new CommandError(`Tooth ${cmd.fdi} is not part of this case`);
  if (!isCavityTooth(doc, cmd.fdi)) throw new CommandError(`${cmd.type}: ${cmd.fdi} is not an inlay or onlay`);
  if (cmd.source === 'preop' && !doc.scans.some((s) => s.role === 'preop')) throw new CommandError(`${cmd.type}: the case has no pre-op scan`);
  const changed = outerSourceOf(doc, cmd.fdi) !== cmd.source;
  return {
    ...doc,
    teeth: doc.teeth.map((t) => (t.fdi !== cmd.fdi ? t : changed ? { ...redoProposal(t, markStaleFrom), outerSource: cmd.source } : { ...t, outerSource: cmd.source })),
  };
}

/** A pre-op inlay: its outer surface is the pre-op scan, so it has no pose to move (no gizmo, nudges or move commands). */
export const followsPreop = (doc: Pick<DesignDocument, 'setup' | 'scans' | 'teeth'>, fdi: number): boolean => isCavityTooth(doc, fdi) && outerSourceOf(doc, fdi) === 'preop';

/**
 * The pre-op scan was added, replaced or removed: inlays whose effective source changes redo their proposal, and
 * inlays on the pre-op scan go stale from the proposal when it was replaced.
 */
export function syncPreop(before: DesignDocument, after: DesignDocument, markStaleFrom: (steps: Steps, step: StepId) => Steps): DesignDocument {
  const sha = (scans: readonly ScanRef[]) => scans.find((s) => s.role === 'preop')?.mesh.sha256;
  if (sha(before.scans) === sha(after.scans)) return after;
  const teeth = after.teeth.map((t) => {
    if (!isCavityTooth(after, t.fdi)) return t;
    const was = outerSourceOf(before, t.fdi), now = outerSourceOf(after, t.fdi);
    if (was !== now) return t.crown ? redoProposal(t, markStaleFrom) : t;
    return now === 'preop' ? { ...t, steps: markStaleFrom(t.steps, 'proposal') } : t;
  });
  return { ...after, teeth };
}

/** A pre-op inlay follows the scan: it has no pose to move. */
export function requireMovable(doc: DesignDocument, fdi: number, type: string): void {
  if (followsPreop(doc, fdi)) {
    throw new CommandError(`${type}: ${fdi} follows the pre-op scan; switch its outer surface to the library tooth to move it`);
  }
}
