import type { ClinicalAxis, ClinicalDirection, Command } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import { useToolStore } from './toolStore';

/** Nudge sizes: small and Shift (large). */
export const MOVE_MM = { small: 0.1, large: 0.5 } as const;
export const ROTATE_DEG = 2;
export const SCALE_PCT = 2;

type Nudge =
  | { kind: 'move'; direction: ClinicalDirection; mm: number }
  | { kind: 'rotate'; axis: ClinicalAxis; deg: number }
  | { kind: 'scale'; axis: ClinicalAxis; pct: number };

/** Apply one clinical nudge to the active tooth's crown as an undoable command. */
export function nudge(n: Nudge): void {
  const { activeFdi: fdi, dispatch } = useDesignStore.getState();
  const cmd: Command =
    n.kind === 'move'
      ? { type: 'moveCrown', fdi, direction: n.direction, mm: n.mm }
      : n.kind === 'rotate'
        ? { type: 'rotateCrown', fdi, axis: n.axis, deg: n.deg }
        : { type: 'scaleCrown', fdi, axis: n.axis, pct: n.pct };
  try {
    dispatch(cmd);
  } catch (e) {
    useToolStore.getState().set({ message: { kind: 'error', text: e instanceof Error ? e.message : String(e) } });
  }
}

export const moveCrown = (direction: ClinicalDirection, large = false) =>
  nudge({ kind: 'move', direction, mm: large ? MOVE_MM.large : MOVE_MM.small });

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
