import { ProposalEvent, type Crown, type DesignDocument, type ImplantDesign, type InsertionAxis, type MarginLine, type QaCheck, type StepId, type ToothFrame } from '@dcad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { applyCommands } from '../design/reducer';
import { useDesignStore } from '../design/store';
import type { Proposal, Proposer } from './proposers';
import { bridgeGate } from './qa';

vi.mock('../state/session', () => ({ useSessionStore: { getState: () => ({ currentCase: null }) } }));
vi.mock('../tools/crownTool', () => ({ crownTool: { settled: async () => null } }));

const frame: ToothFrame = { origin: [0, 0, 0], occlusal: [0, 0, 1], mesial: [0, 1, 0], buccal: [1, 0, 0], source: 'auto' };
const margin: MarginLine = { anchors: [{ p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }], points: [{ p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }], source: 'auto' };
const axis: InsertionAxis = { direction: [0, 0, 1], source: 'auto' };

/** Stub proposers: frame → margin → axis, with a switch to fail the axis gate (and switches for the bridge stubs). */
const behaviour = { axisPasses: true, proposalPasses: true, connectorsPass: false, shift: 0 };
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

/**
 * Bridge stubs 35–[36]–37: each proposes for its units. The proposal re-lays the pontic frame, as
 * bridgeProposalCommands does; the connector gate runs the real bridgeGate on a failed union unless switched to pass.
 */
const crown = (): Crown => ({ kind: 'template', templateId: 't', pose: { position: [behaviour.shift, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } });
const units = (fdis: number[], artifact: unknown) => ({ units: fdis.map((fdi) => ({ fdi, artifact })) });
const bridgeSetup = {
  patientRef: '',
  notes: '',
  teeth: [35, 36, 37].map((fdi) => ({ fdi, restoration: fdi === 36 ? ('pontic' as const) : ('anatomic-crown' as const), material: 'zirconia' as const })),
  connections: [[35, 36], [36, 37]] as Array<[number, number]>,
};
/** The same bridge on implants 35i–[36]–37i: the abutments' margin step is the scan-body match. */
const implantSetup = { ...bridgeSetup, teeth: bridgeSetup.teeth.map((t) => (t.fdi === 36 ? t : { ...t, restoration: 'implant-crown' as const })) };
const implantTooth = (doc: DesignDocument, fdi: number) => doc.setup.teeth.some((t) => t.fdi === fdi && t.restoration === 'implant-crown');
const implant: ImplantDesign = {
  libraryId: 'synthetic-generic@1/rp-non-engaging',
  scanBodyPose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  engaging: false,
  ascMaxDeg: 25,
  fit: { rmsMm: 0.01, maxMm: 0.04, inlierFraction: 0.99, coverage: 0.8 },
  source: 'auto',
};
const bridgeStub = (step: StepId, id: string, out: (fdi: number) => Proposal['output'], qa: () => QaCheck[] = () => [{ id: `${step}.check`, passed: true, message: 'stub' }], perAbutment = false): Proposer => ({
  id,
  step,
  perAbutment,
  async run({ fdi }) {
    return { proposerId: id, output: out(fdi!), qa: qa(), rationale: 'stub' };
  },
});

vi.mock('./proposers', () => ({
  PROPOSERS: [
    stub('frame', 'classical.frame-seed@1', () => ({ type: 'setFrame', fdi: 36, frame }), () => true, () => { const { source: _s, ...f } = frame; return f; }),
    {
      ...stub('margin', 'classical.margin-ridge@1', () => ({ type: 'setMargin', fdi: 36, margin }), () => true, () => ({ anchors: margin.anchors.map((a) => a.p), points: margin.points.map((m) => m.p) })),
      // As the real proposer: never on a cavity (its margin is traced by hand).
      appliesTo: (doc: DesignDocument, fdi: number) => !doc.setup.teeth.some((t) => t.fdi === fdi && t.restoration === 'inlay'),
    },
    stub('axis', 'classical.axis-least-undercut@1', () => ({ type: 'setAxis', fdi: 36, axis }), () => behaviour.axisPasses, () => ({ direction: axis.direction })),
  ],
  BRIDGE_PROPOSERS: [
    bridgeStub('frame', 'classical.pontic-frame@1', () => ({ commands: [{ type: 'setFrame', fdi: 36, frame }], artifact: units([36], frame) })),
    {
      ...bridgeStub('margin', 'classical.margin-ridge@1', (fdi) => ({ commands: [{ type: 'setMargin', fdi, margin }], artifact: { points: margin.points.map((m) => m.p) } }), undefined, true),
      appliesTo: (doc: DesignDocument, fdi: number) => !implantTooth(doc, fdi),
    },
    {
      ...bridgeStub('margin', 'classical.scan-body-match@1', (fdi) => ({ commands: [{ type: 'setImplant', fdi, implant }], artifact: { libraryId: implant.libraryId } }), undefined, true),
      appliesTo: implantTooth,
    },
    bridgeStub('axis', 'classical.bridge-axis@1', () => ({ commands: [{ type: 'setAxis', fdi: 35, axis }], artifact: units([35, 37], { direction: axis.direction }) })),
    bridgeStub(
      'proposal',
      'classical.bridge-proposal@1',
      () => ({
        commands: [{ type: 'setFrame', fdi: 36, frame: { ...frame, origin: [0, 0, -1] } }, ...[35, 36, 37].map((fdi) => ({ type: 'setCrown' as const, fdi, crown: crown() }))],
        artifact: units([35, 36, 37], crown()),
      }),
      () => [{ id: 'proposal.check', passed: behaviour.proposalPasses, message: 'stub' }],
    ),
    bridgeStub('adapt', 'classical.connectors@1', () => ({ commands: [], artifact: undefined }), () =>
      behaviour.connectorsPass ? [{ id: 'bridge.union', passed: true, message: 'stub' }] : bridgeGate({ connectors: [{ between: [35, 36], failures: [] }], unionError: 'not manifold' }),
    ),
  ],
}));

const { accept, recordEditsOnSave, reject, resetOrchestrator, runAutoDesign, useOrchestrator } = await import('./orchestrator');
const { useEventLog } = await import('./events');

describe('auto-design orchestrator', () => {
  beforeEach(() => {
    useDesignStore.getState().load(newDocument(), 0);
    resetOrchestrator();
    useEventLog.setState({ queued: [], sent: 0, lastError: null });
    Object.assign(behaviour, { axisPasses: true, proposalPasses: true, connectorsPass: false, shift: 0 });
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

  it('stops at a failed gate with the draft on screen; reject restores and logs rejected (crown and bridge)', async () => {
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

    // Bridge 35–[36]–37: it needs a frame on every abutment, and names the missing one.
    useEventLog.setState({ queued: [] });
    const unframed = applyCommands(newDocument(), [{ type: 'setCaseSetup', setup: bridgeSetup }, { type: 'setFrame', fdi: 35, frame }]);
    useDesignStore.getState().load(unframed, 0);
    useDesignStore.getState().setActiveFdi(36);
    await runAutoDesign();
    expect(useDesignStore.getState().transaction).toBeNull();
    expect(useOrchestrator.getState().error).toMatch(/37/);
    // With both frames: per-abutment margins, then the bridge steps; the connector gate (bridgeGate on a union that
    // failed) stops the draft. Reject logs one event per unit and step: the pontic has no margin or axis event.
    const framed = applyCommands(unframed, [{ type: 'setFrame', fdi: 37, frame }]);
    useDesignStore.getState().load(framed, 0);
    useDesignStore.getState().setActiveFdi(36);
    await runAutoDesign();
    const b = useOrchestrator.getState();
    expect(b.steps.map((s) => [s.proposerId, s.fdi ?? null, s.status])).toEqual([
      ['classical.pontic-frame@1', null, 'passed'],
      ['classical.margin-ridge@1', 35, 'passed'],
      ['classical.margin-ridge@1', 37, 'passed'],
      ['classical.bridge-axis@1', null, 'passed'],
      ['classical.bridge-proposal@1', null, 'passed'],
      ['classical.connectors@1', null, 'failed'],
    ]);
    expect(b.pendingReview && !b.complete).toBe(true);
    expect(useDesignStore.getState().doc.teeth.map((t) => [t.fdi, Boolean(t.crown), t.axis?.direction ?? null])).toEqual([[35, true, axis.direction], [36, true, null], [37, true, axis.direction]]);
    reject();
    expect(useDesignStore.getState().doc).toBe(framed);
    expect(useEventLog.getState().queued.map((e) => [e.fdi, e.step, e.action])).toEqual([
      [36, 'frame', 'rejected'],
      [35, 'margin', 'rejected'],
      [37, 'margin', 'rejected'],
      [35, 'axis', 'rejected'],
      [37, 'axis', 'rejected'],
      [35, 'proposal', 'rejected'],
      [36, 'proposal', 'rejected'],
      [37, 'proposal', 'rejected'],
    ]);

    // Implant bridge 35i–[36]–37i: the implant position (scan-body match) replaces the margin on each abutment.
    const implants = applyCommands(newDocument(), [{ type: 'setCaseSetup', setup: implantSetup }, { type: 'setFrame', fdi: 35, frame }, { type: 'setFrame', fdi: 37, frame }]);
    useDesignStore.getState().load(implants, 0);
    useDesignStore.getState().setActiveFdi(36);
    await runAutoDesign();
    expect(useOrchestrator.getState().steps.map((s) => [s.proposerId, s.fdi ?? null, s.status])).toEqual([
      ['classical.pontic-frame@1', null, 'passed'],
      ['classical.scan-body-match@1', 35, 'passed'],
      ['classical.scan-body-match@1', 37, 'passed'],
      ['classical.bridge-axis@1', null, 'passed'],
      ['classical.bridge-proposal@1', null, 'passed'],
      ['classical.connectors@1', null, 'failed'],
    ]);
    expect(useDesignStore.getState().doc.teeth.map((t) => [t.fdi, t.implant?.libraryId ?? null, Boolean(t.margin), t.steps.margin])).toEqual([
      [35, implant.libraryId, false, 'done'],
      [36, null, false, 'pending'],
      [37, implant.libraryId, false, 'done'],
    ]);
    reject();
    expect(useDesignStore.getState().doc).toBe(implants);
  });

  it('starts at the margin when a frame exists, and logs edits on save (crown and bridge)', async () => {
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

    // Bridge: accepted events per unit and step. The bridge proposal re-lays the pontic frame, so edits are measured
    // from the accepted document, not from the frame step's artifact. A later run whose proposal fails its gate,
    // accepted as it stands, replaces the earlier proposal. Neither is the designer's edit: saving logs none.
    const framed = applyCommands(newDocument(), [{ type: 'setCaseSetup', setup: bridgeSetup }, { type: 'setFrame', fdi: 35, frame }, { type: 'setFrame', fdi: 37, frame }]);
    useDesignStore.getState().load(framed, 0);
    useDesignStore.getState().setActiveFdi(36);
    behaviour.connectorsPass = true;
    useEventLog.setState({ queued: [] });
    await runAutoDesign();
    expect(useOrchestrator.getState().complete).toBe(true);
    accept();
    expect(useEventLog.getState().queued.map((e) => [e.fdi, e.step, e.action])).toEqual([
      [36, 'frame', 'accepted'],
      [35, 'margin', 'accepted'],
      [37, 'margin', 'accepted'],
      [35, 'axis', 'accepted'],
      [37, 'axis', 'accepted'],
      [35, 'proposal', 'accepted'],
      [36, 'proposal', 'accepted'],
      [37, 'proposal', 'accepted'],
    ]);
    Object.assign(behaviour, { proposalPasses: false, shift: 1 });
    await runAutoDesign();
    expect(useOrchestrator.getState().steps.find((s) => s.proposerId === 'classical.bridge-proposal@1')?.status).toBe('failed');
    accept();
    useEventLog.setState({ queued: [] });
    recordEditsOnSave();
    expect(useEventLog.getState().queued).toEqual([]);

    // A single inlay with its frame: no proposer covers the (hand-traced) cavity margin, so the run starts at the axis.
    const inlay = applyCommands(newDocument(), [
      { type: 'setCaseSetup', setup: { patientRef: '', notes: '', teeth: [{ fdi: 36, restoration: 'inlay', material: 'zirconia' }], connections: [] } },
      { type: 'setFrame', fdi: 36, frame },
    ]);
    useDesignStore.getState().load(inlay, 0);
    useDesignStore.getState().setActiveFdi(36);
    await runAutoDesign();
    expect(useOrchestrator.getState().steps.map((s) => [s.proposerId, s.status])).toEqual([
      ['classical.frame-seed@1', 'skipped'],
      ['classical.axis-least-undercut@1', 'passed'],
    ]);
    reject();
  });
});
