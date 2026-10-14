import type { Command, Crown, ToothFrame } from '@dcad/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetOrchestrator, useOrchestrator } from '../ai/orchestrator';
import { newDocument } from '../design/document';
import { useDesignStore } from '../design/store';
import { userEdit } from './nudge';
import { useToolStore } from './toolStore';

describe('designer edits while a draft is open', () => {
  const s = useDesignStore.getState;
  const toothFrame: ToothFrame = { origin: [0, 0, 0], mesial: [0, 1, 0], buccal: [1, 0, 0], occlusal: [0, 0, 1], source: 'auto' };
  const crown: Crown = { kind: 'template', templateId: 'synthetic.lower-molar@1', pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [-1, 1, 1] } };
  const move: Command = { type: 'moveCrown', fdi: 36, direction: 'buccal', mm: 0.5 };
  const position = () => (s().doc.teeth[0]!.crown as Extract<Crown, { kind: 'template' }> | undefined)?.pose.position;
  const openDraft = () => {
    s().beginTransaction({ label: 'Auto-design', author: 'proposer' });
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
    openDraft();
    useOrchestrator.setState({ pendingReview: true });
    expect(userEdit(move)).toBe(true);
    expect(s().transaction).toBeNull();
    expect(s().past).toHaveLength(2);
    expect(position()).toEqual([0.5, 0, 0]);
    expect(useOrchestrator.getState().pendingReview).toBe(false);
    s().undo(); // the move
    expect(position()).toEqual([0, 0, 0]);
    s().undo(); // the draft
    expect(s().doc.teeth[0]!.crown).toBeUndefined();
  });

  it('refuses edits while auto-design is still running', () => {
    openDraft();
    useOrchestrator.setState({ running: true });
    const before = s().doc;
    expect(userEdit(move)).toBe(false);
    expect(s().doc).toBe(before);
    expect(s().transaction).not.toBeNull();
    s().rollbackTransaction();
  });
});
