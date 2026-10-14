import type { Command, Crown, ToothFrame } from '@dcad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistant } from '../ai/agent';
import { resetOrchestrator, useOrchestrator } from '../ai/orchestrator';
import { newDocument } from '../design/document';
import { useDesignStore } from '../design/store';
import { movesForDelta } from './gizmoTool';
import { handleNudgeKey, userEdit } from './nudge';
import { useToolStore } from './toolStore';

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

describe('designer edits while a draft is open', () => {
  const s = useDesignStore.getState;
  const toothFrame: ToothFrame = { ...frame, origin: [0, 0, 0], source: 'auto' };
  const crown: Crown = { kind: 'template', templateId: 'synthetic.lower-molar@1', pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [-1, 1, 1] } };
  const move: Command = { type: 'moveCrown', fdi: 36, direction: 'buccal', mm: 0.5 };
  const position = () => (s().doc.teeth[0]!.crown as Extract<Crown, { kind: 'template' }> | undefined)?.pose.position;
  const openDraft = (author: 'proposer' | 'agent') => {
    s().beginTransaction({ label: author === 'proposer' ? 'Auto-design' : 'Assistant: test', author });
    s().dispatch([
      { type: 'setFrame', fdi: 36, frame: toothFrame },
      { type: 'setCrown', fdi: 36, crown },
    ]);
  };

  beforeEach(() => {
    s().load(newDocument(), 0);
    resetOrchestrator();
    useToolStore.getState().reset();
  });

  it('accepts a pending auto-design first, so the move is its own undo step', () => {
    openDraft('proposer');
    useOrchestrator.setState({ pendingReview: true });
    expect(userEdit(move)).toBe(true);
    expect(s().transaction).toBeNull();
    expect(s().past).toHaveLength(2);
    expect(position()).toEqual([0.5, 0, 0]);
    expect(useToolStore.getState().message?.text).toMatch(/Auto-design accepted/);
    expect(useOrchestrator.getState().pendingReview).toBe(false);
    s().undo(); // the move
    expect(position()).toEqual([0, 0, 0]);
    s().undo(); // the draft
    expect(s().doc.teeth[0]!.crown).toBeUndefined();
  });

  it('accepts a pending assistant change set the same way', () => {
    openDraft('agent');
    expect(userEdit(move)).toBe(true);
    expect(s().transaction).toBeNull();
    expect(s().past).toHaveLength(2);
  });

  it('refuses edits while auto-design is still running', () => {
    openDraft('proposer');
    useOrchestrator.setState({ running: true });
    const before = s().doc;
    expect(userEdit(move)).toBe(false);
    expect(s().doc).toBe(before);
    expect(s().transaction).not.toBeNull();
    expect(useToolStore.getState().message?.kind).toBe('warning');
    s().rollbackTransaction();
    expect(useAssistant.getState().running).toBe(false);
  });
});
