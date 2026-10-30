import { bridgeOf, type DesignDocument, qaValueText, type QaCheck, type StepId, unitKind } from '@dcad/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { cutbackFor } from '../../design/framework';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { accept, reject, runAutoDesign, useOrchestrator, type StepRun } from '../../ai/orchestrator';
import { latestChecks } from '../../ai/qa';
import { crownTool } from '../../tools/crownTool';
import { isImplantTooth } from '../../tools/implantTool';
import { useToolStore } from '../../tools/toolStore';
import { isWing } from '../../tools/wing';
import { isCavity } from '../../tools/inlay';
import { returnTo } from '../history';
import { CheckIcon, FailIcon } from '../icons';
import { ReadinessList, useCrownReadiness } from '../steps/ReadinessList';
import './AutoDesign.css';

type V3 = [number, number, number];

const STEP_LABEL: Record<string, string> = {
  frame: 'Tooth frame',
  margin: 'Margin',
  axis: 'Insertion axis',
  proposal: 'Crown',
  adapt: 'Adapt',
};

/** Rows by proposer (a step can have several: the crown and its screw channel); per-tooth rows add the tooth. */
const PROPOSER_LABEL: Record<string, string> = {
  'classical.scan-body-match@1': 'Implant position',
  'classical.wing-outline@1': 'Wing outline',
  'classical.screw-channel@1': 'Screw channel',
  'classical.cutback@1': 'Cutback',
  'classical.inlay-outer@1': 'Inlay / onlay',
};

/** Rows of a bridge run that read differently from a single crown's. */
const BRIDGE_LABEL: Record<string, string> = {
  'classical.frame-seed@1': 'Tooth frame',
  'classical.pontic-frame@1': 'Pontic frames',
  'classical.margin-ridge@1': 'Margin',
  'classical.bridge-axis@1': 'Common insertion axis',
  'classical.bridge-proposal@1': 'Bridge',
  'classical.adapt@1': 'Adapt',
  'classical.connectors@1': 'Connectors and merged bridge',
};

const rowLabel = (run: StepRun | undefined, bridge: boolean): string => {
  if (!run) return 'a step';
  const label = PROPOSER_LABEL[run.proposerId] ?? (bridge ? BRIDGE_LABEL[run.proposerId] : undefined) ?? STEP_LABEL[run.step] ?? run.step;
  return run.fdi !== undefined ? `${label} ${run.fdi}` : label;
};

/** What auto-design does for the active tooth or bridge, in the order it runs (the steps that apply to it). */
function describeRun(doc: DesignDocument, teeth: readonly number[], bridge: boolean): { what: string; click: string } {
  const implant = teeth.some((f) => isImplantTooth(doc, f));
  const wing = teeth.some((f) => isWing(doc.setup, f));
  // Cavities (inlays, onlays): their margins are traced by hand, and their outer surface needs no adaptation.
  const cavity = teeth.some((f) => isCavity(doc.setup, f));
  const prep = teeth.some((f) => unitKind(doc.setup, f) === 'abutment' && !isImplantTooth(doc, f) && !isWing(doc.setup, f) && !isCavity(doc.setup, f));
  const reduced = teeth.some((f) => cutbackFor(doc, f) !== undefined);
  const list = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''));
  const first = [
    ...(bridge ? ['places the pontics'] : []),
    ...(implant ? [bridge ? 'matches each scan body' : 'matches the scan body (its implant axis is the insertion axis)'] : []),
  ];
  const proposes = [
    ...(implant ? [] : wing ? [prep ? "each abutment's margin or wing outline" : bridge ? 'each wing outline' : 'the wing outline'] : prep ? [bridge ? "each abutment's margin" : 'the margin'] : []),
    ...(bridge ? [implant ? 'the common path over the implant axes' : 'the common insertion axis'] : implant ? [] : ['the insertion axis']),
    bridge ? 'every unit' : cavity ? 'the inlay from its outer source' : 'the crown',
    ...(implant ? [bridge ? 'the screw channels' : 'the screw channel'] : []),
    ...(bridge || !cavity ? ['the adaptation'] : []),
    ...(reduced ? ['the cutback for veneering'] : []),
  ];
  const lead = first.length ? `${list(first)}, then proposes ${list(proposes)}` : `proposes ${list(proposes)}`;
  const traced = cavity ? ` Trace ${bridge ? 'each cavity margin' : 'the cavity margin'} first: it is not proposed.` : '';
  const what = `${lead[0]!.toUpperCase()}${lead.slice(1)}${bridge ? ', and checks the connectors and the merged bridge' : ''}.${traced}`;
  return { what, click: implant ? 'one click on each scan body' : wing ? 'one click on the lingual surface of each wing abutment' : cavity ? 'one click on each cavity floor' : 'one click on each prep' };
}

/**
 * When a draft opens for review, show what it made before the user decides:
 * a complete draft opens Crown proposal with the occlusion map on; a draft
 * that stopped opens the step whose check failed (on its tooth, for a
 * per-tooth row of a bridge).
 */
useOrchestrator.subscribe((s, prev) => {
  if (!s.pendingReview || prev.pendingReview) return;
  const failed = s.steps.find((r) => r.status === 'failed');
  const target: StepId = failed?.step ?? 'proposal';
  const design = useDesignStore.getState();
  if (failed?.fdi !== undefined) design.setActiveFdi(failed.fdi);
  design.setActiveStep(target);
  if ((target === 'proposal' || target === 'adapt') && selectActiveTooth(useDesignStore.getState())?.crown) crownTool.setMap('occlusion');
});

function acceptDraft(complete: boolean, failed: StepRun | undefined, bridge: boolean): void {
  accept();
  const text = complete
    ? 'Draft accepted. Undo (Ctrl/⌘+Z) takes it back in one step.'
    : `Draft kept. Finish ${rowLabel(failed, bridge)} yourself; Undo (Ctrl/⌘+Z) takes the draft back.`;
  useToolStore.getState().set({ message: { kind: 'info', text } });
}

/** Reject goes back to where the run started (the step it was started on, or the earliest step not done). */
function rejectDraft(): void {
  const origin = reject();
  if (origin) returnTo(origin);
  useToolStore.getState().set({ message: { kind: 'info', text: 'Draft rejected. The design is back to where it was before auto-design.' } });
}

/** How many AutoDesign panels are on screen (the Frame and Proposal steps have one; DraftReview covers the rest). */
const usePanels = create<{ open: number }>(() => ({ open: 0 }));

const checkValue = (c: QaCheck) => (c.value === undefined ? '' : ` (${qaValueText(c)})`);

/** What to do about a draft that stopped, in plain words, by the step that failed. */
function nextAction(failed: StepRun | undefined, bridge: boolean): string {
  switch (failed?.step) {
    case 'frame':
      return 'That click did not give a tooth frame. Reject, then click the top of the prepared tooth.';
    case 'margin':
      return 'The margin was not found cleanly. If you clicked the wrong tooth, reject and click the prep. Otherwise keep the draft and trace the margin yourself.';
    case 'axis':
      return 'No insertion axis passed. Keep the draft and set the axis yourself, or reject it.';
    case 'proposal':
      return `The ${bridge ? 'bridge' : 'crown'} failed a check. Keep the draft and change the parameters or the ${bridge ? 'units' : 'crown'}, or reject it.`;
    case 'adapt':
      return 'The adaptation failed a check. Keep the draft and adjust it in Adapt, or reject it.';
    default:
      return 'Keep the draft and finish the step yourself, or reject it.';
  }
}

/** The draft's ready-to-mill rows (Finalize's, measured on the draft): what a technician judges it by. */
function DraftReadiness() {
  const readiness = useCrownReadiness();
  return readiness ? <ReadinessList items={readiness.items} compact /> : null;
}

/**
 * The review of an open draft: the verdict, the clinical rows of a crown draft, and the step checks folded away. A
 * draft that stopped also says what to do and shows its failing checks. A complete draft offers Accept as the main
 * action; a draft that stopped offers Reject, with "Keep the draft" (the passed steps, and the failed step's output to
 * fix by hand) beside it.
 */
function Review({ className = '' }: { className?: string }) {
  const { complete, steps, bridge } = useOrchestrator();
  const isBridge = Boolean(bridge);
  // A single unit with a crown: the rows Finalize gates on (a bridge's are per unit, in Finalize).
  const crowned = useDesignStore((s) => !isBridge && Boolean(selectActiveTooth(s)?.crown));
  // Each check once: a check measured again by a later step shows on that step only.
  const ran = latestChecks(steps.filter((s) => s.status === 'passed' || s.status === 'failed'));
  const failed = steps.find((s) => s.status === 'failed');
  const failing = failed?.qa.filter((c) => !c.passed) ?? [];
  const checks = ran.reduce((n, r) => n + r.qa.length, 0);
  const passedAny = ran.some((r) => r.status === 'passed');
  const keep = (
    <button key="accept" className={`btn${complete ? ' primary' : ''}`} onClick={() => acceptDraft(complete, failed, isBridge)}>
      {complete ? 'Accept' : 'Keep the draft'}
    </button>
  );
  const discard = (
    <button key="reject" className={`btn${complete ? '' : ' primary'}`} onClick={rejectDraft}>
      Reject
    </button>
  );
  return (
    <div className={`auto-banner ${className}`} role="status">
      <strong>{complete ? `Draft ready: all ${checks} checks passed` : `Draft stopped at ${rowLabel(failed, isBridge)}`}</strong>
      {!complete && <span className="small">{nextAction(failed, isBridge)}</span>}
      {failing.length > 0 && (
        <ul className="auto-checks">
          {failing.map((c) => (
            <li key={c.id} className="fail">
              <FailIcon />
              <span>
                {c.message}
                {checkValue(c)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {crowned && <DraftReadiness />}
      <div className="row">{complete ? [keep, discard] : passedAny || failed?.step !== 'frame' ? [discard, keep] : [discard]}</div>
      {ran.length > 0 && (
        <details className="auto-details">
          <summary>Show the step checks ({checks})</summary>
          <ol className="auto-steps">
            {ran.map((r) => (
              <StepRow key={r.key} run={r} review bridge={isBridge} />
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/**
 * Accept / Reject for an open auto-design draft on a step without the auto-design panel. A draft that stops opens
 * the step whose check failed (Margin, Insertion axis or Adapt, where the failure can be seen and fixed), so the
 * decision has to be reachable there too.
 */
export function DraftReview() {
  const panels = usePanels((s) => s.open);
  const open = useDraftOpen();
  const pendingReview = useOrchestrator((s) => s.pendingReview);
  if (panels > 0 || !open || !pendingReview) return null;
  return <Review className="draft-review" />;
}

/** Whether an auto-design draft is running or open for review (nothing else should look like the next action). */
export const useDraftOpen = (): boolean => useDesignStore((s) => s.transaction?.author === 'proposer');

function StepRow({ run, review, bridge }: { run: StepRun; review: boolean; bridge: boolean }) {
  const showChecks = review && run.qa.length > 0;
  return (
    <li className={run.status}>
      <span className="auto-icon">
        {run.status === 'running' ? <span className="spinner" /> : run.status === 'passed' ? <CheckIcon /> : run.status === 'failed' ? <FailIcon /> : <span className="auto-dot" />}
      </span>
      <span className="auto-label">
        {rowLabel(run, bridge)}
        <span className="visually-hidden">: {run.status}</span>
      </span>
      {showChecks && (
        <ul className="auto-checks">
          {run.qa.map((c) => (
            <li key={c.id} className={c.passed ? 'pass' : 'fail'}>
              {c.passed ? <CheckIcon /> : <FailIcon />}
              <span>
                {c.message}
                {checkValue(c)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {review && run.rationale && <div className="muted small auto-rationale">{run.rationale}</div>}
    </li>
  );
}

/**
 * One-click design: runs the classical proposers with QA gates and shows the
 * draft for review. A single crown: `seed` (a click on the prep) lets it
 * start from the tooth frame; without it the tooth must already have a frame.
 * A bridge (the active tooth is one of its units): every abutment needs its
 * frame, then the whole bridge is designed. `primary` when it is the step's
 * main action.
 */
export function AutoDesign({ seed, compact = false, primary = true }: { seed?: V3; compact?: boolean; primary?: boolean }) {
  useEffect(() => {
    usePanels.setState((s) => ({ open: s.open + 1 }));
    return () => usePanels.setState((s) => ({ open: s.open - 1 }));
  }, []);
  const tooth = useDesignStore(selectActiveTooth);
  const doc = useDesignStore((s) => s.doc);
  const bridge = useDesignStore((s) => bridgeOf(s.doc, s.activeFdi));
  const transaction = useDesignStore((s) => s.transaction);
  const { running, steps, pendingReview, error, bridge: runBridge } = useOrchestrator();
  const unframed = bridge ? bridge.teeth.filter((f) => unitKind(doc.setup, f) === 'abutment' && !doc.teeth.find((t) => t.fdi === f)?.frame) : [];
  const run = describeRun(doc, bridge?.teeth ?? (tooth ? [tooth.fdi] : []), Boolean(bridge));
  const implant = Boolean(tooth && isImplantTooth(doc, tooth.fdi));
  const unit = tooth && isCavity(doc.setup, tooth.fdi) ? doc.setup.teeth.find((t) => t.fdi === tooth.fdi)!.restoration : 'crown';
  const ready = bridge ? unframed.length === 0 : Boolean(tooth && (tooth.frame || seed));
  const canStart = ready && !running && !transaction;
  const ownDraft = pendingReview && transaction?.author === 'proposer';
  const isBridgeRun = Boolean(runBridge);

  return (
    <section className={`auto-design${ownDraft ? ' review' : ''}`} aria-label="Auto-design">
      {!ownDraft && (
        <>
          <div className="row">
            <button className={`btn${primary ? ' primary' : ''}`} disabled={!canStart} onClick={() => void runAutoDesign({ ...(seed ? { seed } : {}), keepReviewed: compact })}>
              {running ? 'Designing…' : bridge ? 'Auto-design bridge' : `Auto-design ${unit}`}
            </button>
            {bridge
              ? unframed.length > 0 && <span className="muted small">Set the tooth frame on {unframed.join(' and ')} first ({run.click}).</span>
              : !tooth?.frame && !seed && <span className="muted small">Set the tooth frame first (one click on the {implant ? 'scan body' : 'prep'}).</span>}
          </div>
          {!running && steps.length === 0 && (
            <p className="muted small">
              {run.what} {compact ? 'Each must pass its checks; you review before anything is kept.' : 'Each step must pass its checks; you review the result before anything is kept.'}
            </p>
          )}
        </>
      )}
      {error && <div className="warning">{error}</div>}
      {ownDraft && <Review />}
      {!ownDraft && steps.length > 0 && (
        <ol className="auto-steps">
          {steps
            .filter((s) => s.status !== 'skipped')
            .map((s) => (
              <StepRow key={s.key} run={s} review={false} bridge={isBridgeRun} />
            ))}
        </ol>
      )}
    </section>
  );
}
