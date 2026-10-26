import { bridgeOf, cutbackOf, type DesignDocument, type ProposalEvent, type ProposerId, type QaCheck, type StepId, unitKind } from '@dcad/shared';
import { create } from 'zustand';
import { useDesignStore } from '../design/store';
import { crownTool } from '../tools/crownTool';
import { useToolStore } from '../tools/toolStore';
import { type BridgeStepArtifact, buildBridgeProposalEvents, buildProposalEvent, logProposalEvent, type ProposalAction } from './events';
import { BRIDGE_PROPOSERS, PROPOSERS, type Proposer } from './proposers';
import { passed } from './qa';

type V3 = [number, number, number];

export type StepRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface StepRun {
  /** Unique per run: the proposer id, plus `:<fdi>` for a per-tooth row of a bridge (an abutment's margin). */
  key: string;
  /** The design step the row belongs to (where the draft opens when it fails). */
  step: StepId;
  proposerId: string;
  /** Per-tooth rows of a bridge run: the tooth. */
  fdi?: number;
  status: StepRunStatus;
  qa: QaCheck[];
  rationale?: string;
  ms?: number;
}

interface OrchestratorState {
  running: boolean;
  steps: StepRun[];
  /** The units of the bridge being designed (arch order), or null for a single crown. */
  bridge: number[] | null;
  /** A draft is on screen (transaction open): the user must accept or reject it. */
  pendingReview: boolean;
  /** True when every step passed its gate. */
  complete: boolean;
  error: string | null;
}

const IDLE = { running: false, steps: [], bridge: null, pendingReview: false, complete: false, error: null } satisfies OrchestratorState;

export const useOrchestrator = create<OrchestratorState>()(() => ({ ...IDLE }));

/** One row of a run: a proposer, the tooth it runs on, and (for per-tooth rows) the tooth it is shown for. */
interface PlanItem {
  key: string;
  proposer: Proposer;
  fdi: number;
  unit?: number;
  /** Its artifact is a BridgeStepArtifact (one event per unit). */
  bridgeWide: boolean;
  /** The click that started the run, for the rows of the tooth it was made on (frame, implant position). */
  seed?: V3;
}

const applies = (p: Proposer, doc: DesignDocument, fdi: number): boolean => p.appliesTo?.(doc, fdi) ?? true;

/** Outputs of the current run, for events (accept/reject). */
interface RunRecord {
  fdi: number;
  step: StepId;
  proposerId: ProposerId;
  artifact: unknown;
  bridgeWide: boolean;
  passed: boolean;
  durationMs: number;
}

/** An accepted proposal for one tooth and step, with the document's output when it was accepted (edit detection). */
interface AcceptedRecord {
  fdi: number;
  step: StepId;
  proposerId: ProposerId;
  artifact: unknown;
  /** JSON of the step output at accept time. */
  baseline: string;
  durationMs: number;
}

let currentRun: RunRecord[] = [];
/** Accepted proposals whose step output may still be edited before the next save. */
let accepted: AcceptedRecord[] = [];

/** Max time to wait for the derived crown to catch up with a step (display only). */
const SETTLE_TIMEOUT_MS = 60_000;

const patchRow = (key: string, patch: Partial<StepRun>) =>
  useOrchestrator.setState((s) => ({ steps: s.steps.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));

const settleCrown = () =>
  Promise.race([crownTool.settled(), new Promise<null>((resolve) => setTimeout(() => resolve(null), SETTLE_TIMEOUT_MS))]);

/**
 * One-click design: run the classical proposers in order inside one design-store transaction, applying each proposal
 * live and gating on deterministic QA checks. Stops at the first failed gate; the draft stays on screen until
 * accept() or reject().
 *
 * Single unit (frame → margin or implant position → axis → crown → screw channel → adapt → cutback; the proposers that
 * apply to the tooth's restoration). Start: `from` if given; otherwise at the frame when a seed click is given or no
 * frame exists yet, else at the margin step.
 *
 * Bridge (the active tooth is a unit of one): see runBridgeAutoDesign.
 */
export async function runAutoDesign(opts: { seed?: V3; from?: StepId } = {}): Promise<void> {
  const design = useDesignStore.getState();
  if (useOrchestrator.getState().running) return;
  if (design.transaction) {
    useOrchestrator.setState({ error: 'Accept or reject the open proposal first.' });
    return;
  }
  if (bridgeOf(design.doc, design.activeFdi)) return runBridgeAutoDesign(opts);
  const tooth = design.doc.teeth.find((t) => t.fdi === design.activeFdi);
  if (!tooth) return;
  const start: StepId = opts.from ?? (opts.seed || !tooth.frame ? 'frame' : 'margin');
  if (start === 'frame' && !opts.seed) {
    useOrchestrator.setState({ error: 'Click the prep first: auto-design starts from the tooth frame.' });
    return;
  }
  const plan = PROPOSERS.filter((p) => applies(p, design.doc, tooth.fdi)).map(
    (p): PlanItem => ({ key: p.id, proposer: p, fdi: tooth.fdi, bridgeWide: false, ...(opts.seed ? { seed: opts.seed } : {}) }),
  );
  const startIndex = Math.max(0, plan.findIndex((p) => p.proposer.step === start));
  await execute({ plan, startIndex, label: 'Auto-design', bridge: null });
}

/**
 * Bridge auto-design. Every abutment needs its frame (one click on each prep in the Frame step); without them it
 * stops with an error naming the missing abutments. With a seed click (one-click armed) on an abutment, that click
 * sets its frame: while other abutments still miss theirs it is applied as a plain edit and the next abutment is
 * armed; the click on the last one starts the run.
 *
 * One transaction: [the clicked abutment's frame] → pontic frames (abutments aligned to the arch) → each abutment's
 * margin, implant position or wing outline → the common axis (the implant path) → every unit → screw channels →
 * adaptation → cutback → the connector and union gate. Per-abutment rows run on the abutments they apply to.
 */
async function runBridgeAutoDesign(opts: { seed?: V3; from?: StepId }): Promise<void> {
  const { doc, activeFdi } = useDesignStore.getState();
  const bridge = bridgeOf(doc, activeFdi)!;
  const abutments = bridge.teeth.filter((t) => unitKind(doc.setup, t) === 'abutment');
  const seedFdi = opts.seed && abutments.includes(activeFdi) ? activeFdi : undefined;
  const missing = abutments.filter((t) => t !== seedFdi && !doc.teeth.find((x) => x.fdi === t)?.frame);
  const frameSeed = PROPOSERS.find((p) => p.step === 'frame');
  if (missing.length) {
    if (seedFdi !== undefined && opts.seed && frameSeed) return frameThenArmNext(frameSeed, seedFdi, opts.seed, missing[0]!);
    useOrchestrator.setState({
      error: `Bridge auto-design needs a frame on every abutment: click the prep of ${missing.join(' and ')} in the Frame step first.`,
    });
    return;
  }
  const seedOf = (fdi: number) => (opts.seed && fdi === seedFdi ? { seed: opts.seed } : {});
  const plan: PlanItem[] = [];
  if (seedFdi !== undefined && frameSeed) plan.push({ key: `${frameSeed.id}:${seedFdi}`, proposer: frameSeed, fdi: seedFdi, unit: seedFdi, bridgeWide: false, ...seedOf(seedFdi) });
  for (const p of BRIDGE_PROPOSERS) {
    if (p.perAbutment) {
      for (const a of abutments.filter((t) => applies(p, doc, t))) plan.push({ key: `${p.id}:${a}`, proposer: p, fdi: a, unit: a, bridgeWide: false, ...seedOf(a) });
    } else if (applies(p, doc, activeFdi)) {
      plan.push({ key: p.id, proposer: p, fdi: activeFdi, bridgeWide: true });
    }
  }
  const startIndex = opts.from ? Math.max(0, plan.findIndex((p) => p.proposer.step === opts.from)) : 0;
  await execute({ plan, startIndex, label: `Auto-design bridge ${bridge.teeth[0]}–${bridge.teeth.at(-1)}`, bridge: [...bridge.teeth] });
}

/**
 * One-click bridge, before the last abutment: the click sets this abutment's frame once it passes its gate (a plain
 * edit, so its proposal is accepted now), then arms the next abutment. On a failure one-click stays armed for another
 * click on the same prep.
 */
async function frameThenArmNext(proposer: Proposer, fdi: number, seed: V3, next: number): Promise<void> {
  useOrchestrator.setState({ ...IDLE, running: true });
  const t0 = performance.now();
  try {
    const proposal = await proposer.run({ seed, fdi });
    if (!passed(proposal.qa)) {
      throw new Error(`The frame of ${fdi} failed its check: ${proposal.qa.filter((c) => !c.passed).map((c) => c.message).join('; ')}. Click the prep again.`);
    }
    useDesignStore.getState().dispatch(proposal.output.commands);
    acceptRuns([{ fdi, step: proposer.step, proposerId: proposer.id, artifact: proposal.output.artifact, bridgeWide: false, passed: true, durationMs: performance.now() - t0 }]);
    useDesignStore.getState().setActiveFdi(next);
    useToolStore.getState().set({
      autoArmed: true,
      framePick: 'seed',
      message: { kind: 'info', text: `Frame set on ${fdi}. Click the prep of ${next} next: the bridge is designed after the last abutment.` },
    });
    useOrchestrator.setState({ running: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useOrchestrator.setState({ running: false, error: message });
    // The Frame step shows the auto-design panel only once the tooth has a frame: say it where the click was made.
    useToolStore.getState().set({ autoArmed: true, framePick: 'seed', message: { kind: 'error', text: message } });
  }
}

async function execute(input: { plan: PlanItem[]; startIndex: number; label: string; bridge: number[] | null }): Promise<void> {
  const { plan, startIndex } = input;
  useOrchestrator.setState({
    running: true,
    pendingReview: false,
    complete: false,
    error: null,
    bridge: input.bridge,
    steps: plan.map((p, i) => ({
      key: p.key,
      step: p.proposer.step,
      proposerId: p.proposer.id,
      ...(p.unit !== undefined ? { fdi: p.unit } : {}),
      status: i < startIndex ? 'skipped' : 'pending',
      qa: [],
    })),
  });
  currentRun = [];
  const runFdi = useDesignStore.getState().activeFdi;
  useDesignStore.getState().beginTransaction({ label: input.label, author: 'proposer' });
  let failed = false;
  for (const item of plan.slice(startIndex)) {
    const { proposer } = item;
    patchRow(item.key, { status: 'running' });
    const t0 = performance.now();
    try {
      const proposal = await proposer.run({ seed: item.seed, fdi: item.fdi });
      if (proposal.output.commands.length) useDesignStore.getState().dispatch(proposal.output.commands);
      if (useDesignStore.getState().doc.teeth.find((t) => t.fdi === runFdi)?.crown) await settleCrown();
      const ok = passed(proposal.qa);
      const ms = performance.now() - t0;
      currentRun.push({ fdi: item.fdi, step: proposer.step, proposerId: proposer.id, artifact: proposal.output.artifact, bridgeWide: item.bridgeWide, passed: ok, durationMs: ms });
      patchRow(item.key, { status: ok ? 'passed' : 'failed', qa: proposal.qa, rationale: proposal.rationale, ms });
      if (!ok) {
        failed = true;
        break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchRow(item.key, {
        status: 'failed',
        qa: [{ id: `${proposer.step}.error`, passed: false, message }],
        ms: performance.now() - t0,
      });
      failed = true;
      break;
    }
  }
  useOrchestrator.setState({ running: false, pendingReview: true, complete: !failed });
}

/** The events of one run record: one per tooth (a bridge-wide record: one per unit), none for a gate. */
function eventsOf(run: RunRecord, action: ProposalAction): ProposalEvent[] {
  if (run.artifact === undefined) return [];
  if (run.bridgeWide) {
    return buildBridgeProposalEvents({ step: run.step, proposerId: run.proposerId, proposal: run.artifact as BridgeStepArtifact, action, durationMs: run.durationMs });
  }
  return [buildProposalEvent({ fdi: run.fdi, step: run.step, proposerId: run.proposerId, proposal: run.artifact, action, durationMs: run.durationMs })];
}

/** The teeth a run record proposed for (a bridge-wide record: its units). */
const teethOf = (run: RunRecord): number[] =>
  run.bridgeWide ? ((run.artifact as BridgeStepArtifact | undefined)?.units ?? []).map((u) => u.fdi) : [run.fdi];

/**
 * Log `accepted` events for runs whose output is now in the document, and remember each tooth's step output as it is
 * now (the baseline for edit detection on save; a later step may have changed it, e.g. the bridge proposal re-lays a
 * pontic frame).
 */
function acceptRuns(runs: readonly RunRecord[]): void {
  const records: AcceptedRecord[] = [];
  for (const run of runs) {
    for (const event of eventsOf(run, 'accepted')) {
      logProposalEvent(event);
      const artifact = (event.proposal as { value: unknown }).value;
      records.push({
        fdi: event.fdi,
        step: event.step,
        proposerId: event.proposerId,
        artifact,
        baseline: JSON.stringify(currentOutput(event.fdi, event.step, event.proposerId, withConnectors(artifact))),
        durationMs: run.durationMs,
      });
    }
  }
  accepted = [...accepted.filter((a) => !records.some((r) => sameOutput(r, a))), ...records];
}

/** The same output of a proposal: tooth, step and proposer (a step can have several: the crown and its screw channel). */
const sameOutput = (a: Pick<AcceptedRecord, 'fdi' | 'step' | 'proposerId'>, b: Pick<AcceptedRecord, 'fdi' | 'step' | 'proposerId'>) =>
  a.fdi === b.fdi && a.step === b.step && a.proposerId === b.proposerId;

/** Keep the draft: one undo entry (author "proposer") and `accepted` events for the passed steps. */
export function accept(): void {
  const design = useDesignStore.getState();
  if (!design.transaction) return;
  design.commitTransaction();
  // Every step this run proposed replaces what an earlier run proposed for it, a failed step included: its output is
  // in the document now, and is not the designer's correction of the earlier proposal.
  const touched = new Set(currentRun.flatMap((r) => teethOf(r).map((fdi) => `${fdi}:${r.step}:${r.proposerId}`)));
  accepted = accepted.filter((a) => !touched.has(`${a.fdi}:${a.step}:${a.proposerId}`));
  acceptRuns(currentRun.filter((r) => r.passed));
  currentRun = [];
  useOrchestrator.setState({ ...IDLE });
}

/** Discard the draft (rollback) and log `rejected` events for every step that ran. */
export function reject(): void {
  const design = useDesignStore.getState();
  if (!design.transaction) return;
  // Build the events before rolling back, while the document still has the run's teeth.
  const events = currentRun.flatMap((run) => eventsOf(run, 'rejected'));
  design.rollbackTransaction();
  events.forEach(logProposalEvent);
  currentRun = [];
  useOrchestrator.setState({ ...IDLE });
}

/** A bridge's adapt artifact on its first unit also carries the connector settings (see buildBridgeProposalEvents). */
const withConnectors = (artifact: unknown): boolean => Boolean(artifact && typeof artifact === 'object' && 'connectors' in artifact);

/**
 * The current value of a proposal's output in the document (what an accepted proposal may have been edited into): the
 * step's output, or for the proposers that share a step with another one their own part of it (the screw channel in
 * the proposal step, the cutback in the adapt step).
 */
function currentOutput(fdi: number, step: StepId, proposerId: ProposerId, connectors = false): unknown {
  const { doc } = useDesignStore.getState();
  const tooth = doc.teeth.find((t) => t.fdi === fdi);
  if (!tooth) return undefined;
  if (proposerId === 'classical.screw-channel@1') return tooth.screwChannel ?? null;
  if (proposerId === 'classical.cutback@1') return cutbackOf(doc.setup, tooth);
  switch (step) {
    case 'frame': {
      if (!tooth.frame) return undefined;
      const { source: _source, ...frame } = tooth.frame;
      return frame;
    }
    case 'margin':
      // An implant crown's margin step is its implant position (the scan-body match).
      if (tooth.implant) return { libraryId: tooth.implant.libraryId, scanBodyPose: tooth.implant.scanBodyPose };
      return tooth.margin && { anchors: tooth.margin.anchors.map((a) => a.p), points: tooth.margin.points.map((m) => m.p) };
    case 'axis':
      return tooth.axis && { direction: tooth.axis.direction };
    case 'proposal':
      return tooth.crown?.kind === 'template' ? { kind: 'template', templateId: tooth.crown.templateId, pose: tooth.crown.pose } : tooth.crown;
    case 'adapt': {
      if (tooth.crown?.kind !== 'template') return undefined;
      const adapt = tooth.crown.adapt ?? {};
      return connectors ? { ...adapt, connectors: bridgeOf(doc, fdi)?.connectors ?? [] } : adapt;
    }
    default:
      return undefined;
  }
}

/**
 * Call when the design is saved: accepted proposals whose step output the user changed since they were accepted
 * are logged as `edited` with the final value (the correction is the most valuable training signal). Unchanged ones
 * are simply forgotten.
 */
export function recordEditsOnSave(): void {
  for (const run of accepted) {
    const final = currentOutput(run.fdi, run.step, run.proposerId, withConnectors(run.artifact));
    if (final === undefined || JSON.stringify(final) === run.baseline) continue;
    logProposalEvent(
      buildProposalEvent({
        fdi: run.fdi,
        step: run.step,
        proposerId: run.proposerId,
        proposal: run.artifact,
        finalAccepted: final,
        action: 'edited',
        editsCount: 1,
        durationMs: run.durationMs,
      }),
    );
  }
  accepted = [];
}

/** Test helper: forget accepted proposals and reset the store. */
export function resetOrchestrator(): void {
  currentRun = [];
  accepted = [];
  useOrchestrator.setState({ ...IDLE });
}
