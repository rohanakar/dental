import { stepsFor, unitKind, type StepId } from '@dcad/shared';
import { draftCommitted, type DraftOrigin } from '../ai/orchestrator';
import { useDesignStore } from '../design/store';
import { useToolStore } from '../tools/toolStore';
import { missingBefore } from './stepGuide';

type Place = { step: StepId; fdi: number };

/**
 * After a draft is taken back (Reject, Undo): the tooth and step the run started from, or the earliest step before it
 * that is not done, so the step on screen has one next action. Set the step before the notice: an info notice goes
 * when its step changes.
 */
export function returnTo(place: Place): void {
  const design = useDesignStore.getState();
  design.setActiveFdi(place.fdi);
  const { doc, activeFdi } = useDesignStore.getState();
  const statuses = doc.teeth.find((t) => t.fdi === activeFdi)?.steps;
  design.setActiveStep(missingBefore(place.step, statuses, stepsFor(unitKind(doc.setup, activeFdi))) ?? place.step);
}

/** Where each undone draft was undone from: its redo goes back there. */
const undoneFrom = new WeakMap<DraftOrigin, Place>();

const name = (draft: DraftOrigin) => `${draft.label[0]!.toLowerCase()}${draft.label.slice(1)}`;

/** A notice for an undone or redone draft; any other undo or redo clears the notice about the change it replaced. */
function notice(text: string | null): void {
  const tools = useToolStore.getState();
  if (text) tools.set({ message: { kind: 'info', text } });
  else if (tools.message?.kind === 'info') tools.set({ message: null });
}

/** False (with a warning) while a draft is open: it is accepted or rejected first. */
function historyFree(): boolean {
  if (!useDesignStore.getState().transaction) return true;
  useToolStore.getState().set({ message: { kind: 'warning', text: 'Accept or reject the open draft first; undo works after that.' } });
  return false;
}

/** Undo (keyboard and toolbar). Undoing an accepted auto-design draft returns to where its run started. */
export function undo(): void {
  if (!historyFree()) return;
  const design = useDesignStore.getState();
  if (design.past.length === 0) return;
  const draft = draftCommitted(design.doc);
  const at = { step: design.activeStep, fdi: design.activeFdi };
  design.undo();
  if (draft) {
    undoneFrom.set(draft, at);
    returnTo(draft);
  }
  notice(draft ? `Undone: ${name(draft)}.` : null);
}

/** Redo (keyboard and toolbar). Redoing an auto-design draft returns to the step it was undone from. */
export function redo(): void {
  if (!historyFree()) return;
  const design = useDesignStore.getState();
  const next = design.future[0];
  if (!next) return;
  const draft = draftCommitted(next);
  design.redo();
  const back = draft && undoneFrom.get(draft);
  if (back) {
    design.setActiveFdi(back.fdi);
    design.setActiveStep(back.step);
  }
  notice(draft ? `Redone: ${name(draft)}.` : null);
}
