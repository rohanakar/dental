import { ProposalEvent, type InsertionAxis, type MarginLine, type ToothFrame } from '@dcad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { useDesignStore } from '../design/store';
import type { Proposal, Proposer } from './proposers';

vi.mock('../state/session', () => ({ useSessionStore: { getState: () => ({ currentCase: null }) } }));
vi.mock('../tools/crownTool', () => ({ crownTool: { settled: async () => null } }));

const frame: ToothFrame = { origin: [0, 0, 0], occlusal: [0, 0, 1], mesial: [0, 1, 0], buccal: [1, 0, 0], source: 'auto' };
const margin: MarginLine = { anchors: [{ p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }], points: [{ p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }], source: 'auto' };
const axis: InsertionAxis = { direction: [0, 0, 1], source: 'auto' };

/** Stub proposers: frame → margin → axis, with a switch to fail the axis gate. */
const behaviour = { axisPasses: true };
const stub = (step: 'frame' | 'margin' | 'axis', id: string, command: () => Proposal['output']['commands'][number], pass: () => boolean, artifact: () => unknown): Proposer => ({
  id,
  step,
  async run() {
    return {
      proposerId: id,
      output: { commands: [command()], artifact: artifact() },
      qa: [{ id: `${step}.check`, passed: pass(), message: 'stub' }],
      rationale: 'stub',
    };
  },
});

vi.mock('./proposers', () => ({
  PROPOSERS: [
    stub('frame', 'classical.frame-seed@1', () => ({ type: 'setFrame', fdi: 36, frame }), () => true, () => { const { source: _s, ...f } = frame; return f; }),
    stub('margin', 'classical.margin-ridge@1', () => ({ type: 'setMargin', fdi: 36, margin }), () => true, () => ({ anchors: margin.anchors.map((a) => a.p), points: margin.points.map((m) => m.p) })),
    stub('axis', 'classical.axis-least-undercut@1', () => ({ type: 'setAxis', fdi: 36, axis }), () => behaviour.axisPasses, () => ({ direction: axis.direction })),
  ],
}));

const { accept, recordEditsOnSave, reject, resetOrchestrator, runAutoDesign, useOrchestrator } = await import('./orchestrator');
const { useEventLog } = await import('./events');

describe('auto-design orchestrator', () => {
  beforeEach(() => {
    useDesignStore.getState().load(newDocument(), 0);
    resetOrchestrator();
    useEventLog.setState({ queued: [], sent: 0, lastError: null });
    behaviour.axisPasses = true;
  });

  it('runs every step in one transaction; accept is one undo entry with accepted events', async () => {
    await runAutoDesign({ seed: [0, 0, 0] });
    const o = useOrchestrator.getState();
    expect(o.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed']);
    expect(o.pendingReview && o.complete).toBe(true);
    expect(useDesignStore.getState().transaction).not.toBeNull();
    expect(useDesignStore.getState().doc.teeth[0]!.axis).toEqual(axis);
    expect(useDesignStore.getState().past).toHaveLength(0);
    accept();
    const s = useDesignStore.getState();
    expect(s.transaction).toBeNull();
    expect(s.past).toHaveLength(1);
    expect(s.lastAuthor).toBe('proposer');
    const events = useEventLog.getState().queued;
    expect(events.map((e) => [e.step, e.action])).toEqual([['frame', 'accepted'], ['margin', 'accepted'], ['axis', 'accepted']]);
    for (const e of events) expect(ProposalEvent.safeParse(e).success).toBe(true);
    s.undo();
    expect(useDesignStore.getState().doc.teeth[0]!.frame).toBeUndefined();
  });

  it('stops at a failed gate with the draft on screen; reject restores and logs rejected', async () => {
    behaviour.axisPasses = false;
    const before = useDesignStore.getState().doc;
    await runAutoDesign({ seed: [0, 0, 0] });
    const o = useOrchestrator.getState();
    expect(o.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'failed']);
    expect(o.pendingReview).toBe(true);
    expect(o.complete).toBe(false);
    reject();
    expect(useDesignStore.getState().doc).toBe(before);
    expect(useDesignStore.getState().past).toHaveLength(0);
    expect(useEventLog.getState().queued.map((e) => e.action)).toEqual(['rejected', 'rejected', 'rejected']);
  });

  it('starts at the margin when a frame exists, and logs edits on save', async () => {
    useDesignStore.getState().dispatch({ type: 'setFrame', fdi: 36, frame });
    await runAutoDesign();
    expect(useOrchestrator.getState().steps.map((s) => s.status)).toEqual(['skipped', 'passed', 'passed']);
    accept();
    useEventLog.setState({ queued: [] });
    useDesignStore.getState().dispatch({ type: 'setAxis', fdi: 36, axis: { direction: [0, 0.1, 0.995], source: 'manual' } });
    recordEditsOnSave();
    const edited = useEventLog.getState().queued;
    expect(edited.map((e) => [e.step, e.action])).toEqual([['axis', 'edited']]);
    expect(edited[0]!.finalAccepted).toEqual({ kind: 'json', value: { direction: [0, 0.1, 0.995] } });
  });
});
