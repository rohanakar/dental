import type { Command, ToothFrame } from '@dcad/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDesignStore } from '../design/store';
import { movesForDelta } from './gizmoTool';
import { handleNudgeKey } from './nudge';

const frame: Pick<ToothFrame, 'mesial' | 'buccal' | 'occlusal'> = { mesial: [0, 1, 0], buccal: [1, 0, 0], occlusal: [0, 0, 1] };

describe('gizmo delta → moveCrown batch', () => {
  it('decomposes along the frame, picks clinical directions and splits long moves', () => {
    const cmds = movesForDelta(36, [-0.3, 4.5, 0.002], frame);
    expect(cmds).toEqual([
      { type: 'moveCrown', fdi: 36, direction: 'mesial', mm: 2 },
      { type: 'moveCrown', fdi: 36, direction: 'mesial', mm: 2 },
      { type: 'moveCrown', fdi: 36, direction: 'mesial', mm: 0.5 },
      { type: 'moveCrown', fdi: 36, direction: 'lingual', mm: 0.3 },
    ]);
    expect(movesForDelta(36, [0, 0, -1], frame)).toEqual([{ type: 'moveCrown', fdi: 36, direction: 'cervical', mm: 1 }]);
    expect(movesForDelta(36, [0.001, 0, 0], frame)).toEqual([]);
  });
});

describe('keyboard nudges', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps keys to clinical moves, Shift for the large step', () => {
    const dispatched: Command[] = [];
    vi.spyOn(useDesignStore.getState(), 'dispatch').mockImplementation((c) => {
      dispatched.push(...(Array.isArray(c) ? c : [c]));
      return useDesignStore.getState().doc;
    });
    const key = (k: string, shiftKey = false) => handleNudgeKey({ key: k, shiftKey, ctrlKey: false, metaKey: false, altKey: false });
    expect(key('ArrowLeft')).toBe(true);
    expect(key('PageDown', true)).toBe(true);
    expect(key('a')).toBe(false);
    expect(handleNudgeKey({ key: 'ArrowUp', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(dispatched).toEqual([
      { type: 'moveCrown', fdi: 36, direction: 'mesial', mm: 0.1 },
      { type: 'moveCrown', fdi: 36, direction: 'cervical', mm: 0.5 },
    ]);
  });
});
