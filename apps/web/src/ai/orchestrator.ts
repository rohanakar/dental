import type { QaCheck, StepId } from '@dcad/shared';
import { create } from 'zustand';
import { useDesignStore } from '../design/store';
import { crownTool } from '../tools/crownTool';
import { buildProposalEvent, logProposalEvent } from './events';
import { PROPOSERS, type Proposer } from './proposers';
import { passed } from './qa';

type V3 = [number, number, number];

export type StepRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface StepRun {
  step: StepId;
  proposerId: string;
  status: StepRunStatus;
  qa: QaCheck[];
  rationale?: string;
  ms?: number;
}

interface OrchestratorState {
  running: boolean;
  steps: StepRun[];
  /** A draft is on screen (transaction open): the user must accept or reject it. */
  pendingReview: boolean;
  /** True when every step passed its gate. */
  complete: boolean;
  error: string | null;
}

export const useOrchestrator = create<OrchestratorState>()(() => ({
  running: false,
  steps: [],
  pendingReview: false,
  complete: false,
  error: null,
}));

/** Outputs of the current run, for events (accept/reject) and later edit detection. */
interface RunRecord {
  fdi: number;
  proposer: Proposer;
  artifact: unknown;
  passed: boolean;
  durationMs: number;
}

let currentRun: RunRecord[] = [];
/** Accepted proposals whose step output may still be edited before the next save. */
let accepted: RunRecord[] = [];

/** Max time to wait for the derived crown to catch up with a step (display only). */
const SETTLE_TIMEOUT_MS = 60_000;

const patchStep = (step: StepId, patch: Partial<StepRun>) =>
  useOrchestrator.setState((s) => ({ steps: s.steps.map((r) => (r.step === step ? { ...r, ...patch } : r)) }));

const settleCrown = () =>
  Promise.race([crownTool.settled(), new Promise<null>((resolve) => setTimeout(() => resolve(null), SETTLE_TIMEOUT_MS))]);

/**
 * One-click crown: run the classical proposers in order (frame → margin →
 * axis → crown → adapt) inside one design-store transaction, applying each
 * proposal live and gating on deterministic QA checks. Stops at the first
 * failed gate; the draft stays on screen until accept() or reject().
 *
 * Start: `from` if given; otherwise at the frame when a seed click is given
 * or no frame exists yet, else at the margin.
 */
export async function runAutoDesign(opts: { seed?: V3; from?: StepId } = {}): Promise<void> {
  const design = useDesignStore.getState();
  if (useOrchestrator.getState().running) return;
  if (design.transaction) {
    useOrchestrator.setState({ error: 'Accept or reject the open proposal first.' });
    return;
  }
  const tooth = design.doc.teeth.find((t) => t.fdi === design.activeFdi);
  if (!tooth) return;
  const start: StepId = opts.from ?? (opts.seed || !tooth.frame ? 'frame' : 'margin');
  if (start === 'frame' && !opts.seed) {
    useOrchestrator.setState({ error: 'Click the prep first: auto-design starts from the tooth frame.' });
    return;
  }
  const startIndex = Math.max(0, PROPOSERS.findIndex((p) => p.step === start));
  useOrchestrator.setState({
    running: true,
    pendingReview: false,
    complete: false,
    error: null,
    steps: PROPOSERS.map((p, i) => ({ step: p.step, proposerId: p.id, status: i < startIndex ? 'skipped' : 'pending', qa: [] })),
  });
  currentRun = [];
  design.beginTransaction({ label: 'Auto-design', author: 'proposer' });
  let failed = false;
  for (const proposer of PROPOSERS.slice(startIndex)) {
    patchStep(proposer.step, { status: 'running' });
    const t0 = performance.now();
    try {
      const proposal = await proposer.run({ seed: opts.seed });
      useDesignStore.getState().dispatch(proposal.output.commands);
      if (useDesignStore.getState().doc.teeth.find((t) => t.fdi === tooth.fdi)?.crown) await settleCrown();
      const ok = passed(proposal.qa);
      const ms = performance.now() - t0;
      currentRun.push({ fdi: tooth.fdi, proposer, artifact: proposal.output.artifact, passed: ok, durationMs: ms });
      patchStep(proposer.step, { status: ok ? 'passed' : 'failed', qa: proposal.qa, rationale: proposal.rationale, ms });
      if (!ok) {
        failed = true;
        break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchStep(proposer.step, {
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

/** Keep the draft: one undo entry (author "proposer") and `accepted` events for the passed steps. */
export function accept(): void {
  const design = useDesignStore.getState();
  if (!design.transaction) return;
  design.commitTransaction();
  for (const run of currentRun.filter((r) => r.passed)) {
    logProposalEvent(
      buildProposalEvent({ fdi: run.fdi, step: run.proposer.step, proposerId: run.proposer.id, proposal: run.artifact, action: 'accepted', durationMs: run.durationMs }),
    );
  }
  accepted = [...accepted.filter((a) => !currentRun.some((r) => r.fdi === a.fdi && r.proposer.step === a.proposer.step)), ...currentRun.filter((r) => r.passed)];
  currentRun = [];
  useOrchestrator.setState({ pendingReview: false, steps: [], complete: false, error: null });
}

/** Discard the draft (rollback) and log `rejected` events for every step that ran. */
export function reject(): void {
  const design = useDesignStore.getState();
  if (!design.transaction) return;
  // Build the events before rolling back, while the document still has the run's tooth.
  const events = currentRun.map((run) =>
    buildProposalEvent({ fdi: run.fdi, step: run.proposer.step, proposerId: run.proposer.id, proposal: run.artifact, action: 'rejected', durationMs: run.durationMs }),
  );
  design.rollbackTransaction();
  events.forEach(logProposalEvent);
  currentRun = [];
  useOrchestrator.setState({ pendingReview: false, steps: [], complete: false, error: null });
}

/** The current value of a step's output in the document (what an accepted proposal may have been edited into). */
function currentOutput(fdi: number, step: StepId): unknown {
  const tooth = useDesignStore.getState().doc.teeth.find((t) => t.fdi === fdi);
  if (!tooth) return undefined;
  switch (step) {
    case 'frame': {
      if (!tooth.frame) return undefined;
      const { source: _source, ...frame } = tooth.frame;
      return frame;
    }
    case 'margin':
      return tooth.margin && { anchors: tooth.margin.anchors.map((a) => a.p), points: tooth.margin.points.map((m) => m.p) };
    case 'axis':
      return tooth.axis && { direction: tooth.axis.direction };
    case 'proposal':
      return tooth.crown?.kind === 'template' ? { kind: 'template', templateId: tooth.crown.templateId, pose: tooth.crown.pose } : tooth.crown;
    case 'adapt':
      return tooth.crown?.kind === 'template' ? (tooth.crown.adapt ?? {}) : undefined;
    default:
      return undefined;
  }
}

/**
 * Call when the design is saved: accepted proposals whose step output the
 * user changed since are logged as `edited` with the final value (the
 * correction is the most valuable training signal). Unchanged ones are
 * simply forgotten.
 */
export function recordEditsOnSave(): void {
  for (const run of accepted) {
    const final = currentOutput(run.fdi, run.proposer.step);
    if (final === undefined || JSON.stringify(final) === JSON.stringify(run.artifact)) continue;
    logProposalEvent(
      buildProposalEvent({
        fdi: run.fdi,
        step: run.proposer.step,
        proposerId: run.proposer.id,
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
  useOrchestrator.setState({ running: false, steps: [], pendingReview: false, complete: false, error: null });
}
