import type { ClinicalAxis, ClinicalDirection, Command } from '@dcad/shared';
import { useAssistant } from '../ai/agent';
import { accept as acceptAutoDesign, useOrchestrator } from '../ai/orchestrator';
import { readaptCommands } from '../design/adaptation';
import { useDesignStore } from '../design/store';
import { useToolStore } from './toolStore';
import { isWing } from './wing';

/** Nudge sizes: small and Shift (large). */
export const MOVE_MM = { small: 0.1, large: 0.5 } as const;
export const ROTATE_DEG = 2;
export const SCALE_PCT = 2;

type Nudge =
  | { kind: 'move'; direction: ClinicalDirection; mm: number }
  | { kind: 'rotate'; axis: ClinicalAxis; deg: number }
  | { kind: 'scale'; axis: ClinicalAxis; pct: number };

/**
 * Apply a designer's edit to the crown (gizmo, nudges, keys, adaptation).
 * An auto-design or assistant draft that is waiting for review is accepted
 * first, so the edit is its own undo step instead of silently joining the
 * draft; while either is still running the edit is refused. Returns true
 * when the edit was applied.
 */
export function userEdit(cmds: Command | Command[]): boolean {
  const tools = useToolStore.getState();
  const { transaction } = useDesignStore.getState();
  if (transaction) {
    if (useOrchestrator.getState().running || useAssistant.getState().running) {
      tools.set({ message: { kind: 'warning', text: 'A proposal is still being designed; edit the crown when it is ready.' } });
      return false;
    }
    if (transaction.author === 'proposer') acceptAutoDesign();
    else useAssistant.getState().accept();
    const what = transaction.author === 'proposer' ? 'Auto-design' : 'The assistant’s changes';
    tools.set({ message: { kind: 'info', text: `${what} accepted; your edit is a separate undo step.` } });
  }
  try {
    useDesignStore.getState().dispatch(cmds);
    return true;
  } catch (e) {
    tools.set({ message: { kind: 'error', text: e instanceof Error ? e.message : String(e) } });
    return false;
  }
}

/** Apply one clinical nudge to the active tooth's crown as an undoable command. */
export function nudge(n: Nudge): void {
  const { activeFdi: fdi } = useDesignStore.getState();
  if (isWing(useDesignStore.getState().doc.setup, fdi)) return; // a Maryland wing follows its outline: nothing to move
  const cmd: Command =
    n.kind === 'move'
      ? { type: 'moveCrown', fdi, direction: n.direction, mm: n.mm }
      : n.kind === 'rotate'
        ? { type: 'rotateCrown', fdi, axis: n.axis, deg: n.deg }
        : { type: 'scaleCrown', fdi, axis: n.axis, pct: n.pct };
  userEdit(cmd);
}

export const moveCrown = (direction: ClinicalDirection, large = false) =>
  nudge({ kind: 'move', direction, mm: large ? MOVE_MM.large : MOVE_MM.small });

/** Re-apply the active crown's stored adaptation targets after a move or edit (one undo step). */
export function reAdapt(): void {
  const { doc, activeFdi } = useDesignStore.getState();
  const tooth = doc.teeth.find((t) => t.fdi === activeFdi);
  const cmds = tooth ? readaptCommands(tooth) : [];
  if (cmds.length > 0) userEdit(cmds);
}

const KEY_DIRECTION: Record<string, ClinicalDirection> = {
  ArrowLeft: 'mesial',
  ArrowRight: 'distal',
  ArrowUp: 'buccal',
  ArrowDown: 'lingual',
  PageUp: 'occlusal',
  PageDown: 'cervical',
};

/**
 * Keyboard nudges for the proposal step: ←/→ mesial/distal, ↑/↓
 * buccal/lingual, PageUp/PageDown occlusal/cervical; 0.1 mm, Shift 0.5 mm.
 * Returns true when the key was handled (the caller should preventDefault).
 */
export function handleNudgeKey(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const direction = KEY_DIRECTION[e.key];
  if (!direction) return false;
  moveCrown(direction, e.shiftKey);
  return true;
}
