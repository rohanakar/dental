import { bridgeOf, type QaCheck, type StepId, unitKind } from '@dcad/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { accept, reject, runAutoDesign, useOrchestrator, type StepRun } from '../../ai/orchestrator';
import { crownTool } from '../../tools/crownTool';
import { useToolStore } from '../../tools/toolStore';
import { CheckIcon, FailIcon } from '../icons';
import './AutoDesign.css';

type V3 = [number, number, number];

const STEP_LABEL: Record<string, string> = {
  frame: 'Tooth frame',
  margin: 'Margin',
  axis: 'Insertion axis',
  proposal: 'Crown',
  adapt: 'Adapt',
};

/** Rows of a bridge run, by proposer (per-tooth rows add the tooth). */
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
  const label = (bridge ? BRIDGE_LABEL[run.proposerId] : undefined) ?? STEP_LABEL[run.step] ?? run.step;
  return run.fdi !== undefined ? `${label} ${run.fdi}` : label;
};

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

function acceptDraft(): void {
  accept();
  useToolStore.getState().set({ message: { kind: 'info', text: 'Draft accepted. Undo takes it back in one step.' } });
}

function rejectDraft(): void {
  reject();
  useToolStore.getState().set({ message: { kind: 'info', text: 'Draft rejected. The design is back to where it was before auto-design.' } });
}

/** How many AutoDesign panels are on screen (the Frame and Proposal steps have one; DraftReview covers the rest). */
const usePanels = create<{ open: number }>(() => ({ open: 0 }));

const num = (v: number) => Number(v.toFixed(2));
const checkValue = (c: QaCheck) =>
  c.value === undefined ? '' : c.threshold === undefined ? ` (${num(c.value)})` : ` (${num(c.value)}, limit ${num(c.threshold)})`;

/**
 * Accept / Reject for an open auto-design draft on a step without the auto-design panel. A draft that stops opens
 * the step whose check failed (Margin, Insertion axis or Adapt, where the failure can be seen and fixed), so the
 * decision has to be reachable there too.
 */
export function DraftReview() {
  const panels = usePanels((s) => s.open);
  const draft = useDesignStore((s) => s.transaction?.author === 'proposer');
  const { pendingReview, complete, steps, bridge } = useOrchestrator();
  if (panels > 0 || !draft || !pendingReview) return null;
  const failed = steps.find((s) => s.status === 'failed');
  const failing = failed?.qa.filter((c) => !c.passed) ?? [];
  return (
    <div className="auto-banner draft-review" role="status">
      <strong>{complete ? 'Auto-design draft: every check passed' : `Draft stopped: ${rowLabel(failed, Boolean(bridge))} failed its check`}</strong>
      {failing.length > 0 && (
        <span className="muted small">
          {failing
            .slice(0, 3)
            .map((c) => `${c.message}${checkValue(c)}`)
            .join(' · ')}
        </span>
      )}
      <div className="row">
        <button className="btn" onClick={acceptDraft}>
          Accept
        </button>
        <button className="btn" onClick={rejectDraft}>
          Reject
        </button>
      </div>
    </div>
  );
}

function StepRow({ run, review, bridge }: { run: StepRun; review: boolean; bridge: boolean }) {
  const showChecks = run.status === 'failed' || (review && run.status === 'passed');
  return (
    <li className={run.status}>
      <span className="auto-icon">
        {run.status === 'running' ? <span className="spinner" /> : run.status === 'passed' ? <CheckIcon /> : run.status === 'failed' ? <FailIcon /> : <span className="auto-dot" />}
      </span>
      <span className="auto-label">
        {rowLabel(run, bridge)}
        <span className="visually-hidden">: {run.status}</span>
      </span>
      {showChecks && run.qa.length > 0 && (
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
      {review && run.status === 'passed' && run.rationale && <div className="muted small auto-rationale">{run.rationale}</div>}
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
  const { running, steps, pendingReview, complete, error, bridge: runBridge } = useOrchestrator();
  const unframed = bridge ? bridge.teeth.filter((f) => unitKind(doc.setup, f) === 'abutment' && !doc.teeth.find((t) => t.fdi === f)?.frame) : [];
  const ready = bridge ? unframed.length === 0 : Boolean(tooth && (tooth.frame || seed));
  const canStart = ready && !running && !transaction;
  const ownDraft = pendingReview && transaction?.author === 'proposer';
  const failed = steps.find((s) => s.status === 'failed');
  const isBridgeRun = Boolean(runBridge);

  return (
    <section className={`auto-design${ownDraft ? ' review' : ''}`} aria-label="Auto-design">
      {!ownDraft && (
        <>
          <div className="row">
            <button className={`btn${primary ? ' primary' : ''}`} disabled={!canStart} onClick={() => void runAutoDesign(seed ? { seed } : {})}>
              {running ? 'Designing…' : bridge ? 'Auto-design bridge' : 'Auto-design crown'}
            </button>
            {bridge
              ? unframed.length > 0 && <span className="muted small">Set the tooth frame on {unframed.join(' and ')} first (one click on each prep).</span>
              : !tooth?.frame && !seed && <span className="muted small">Set the tooth frame first (one click on the prep).</span>}
          </div>
          {!running && steps.length === 0 && (
            <p className="muted small">
              {bridge
                ? compact
                  ? 'Places the pontics, then proposes the margins, the common axis, every unit and the adaptation, and checks the connectors; you review before anything is kept.'
                  : 'Places the pontics, proposes each abutment margin, the common insertion axis, every unit and the adaptation, then checks the connectors and the merged bridge. Each step must pass its checks; you review the result before anything is kept.'
                : compact
                  ? 'Proposes margin, axis, crown and adaptation in one go; each must pass its checks, and you review before anything is kept.'
                  : 'Proposes the margin, insertion axis, crown and adaptation in one go. Each step must pass its checks; you review the result before anything is kept.'}
            </p>
          )}
        </>
      )}
      {error && <div className="warning">{error}</div>}
      {ownDraft && (
        <div className="auto-banner" role="status">
          <strong>{complete ? 'Draft ready: every check passed' : `Draft stopped: ${rowLabel(failed, isBridgeRun)} failed its check`}</strong>
          <span className="muted small">
            {complete
              ? `The ${isBridgeRun ? 'bridge' : 'crown'} is on screen with the occlusion map. Accept keeps the whole draft as one undo step.`
              : 'The steps before it are on screen. Accept keeps them; Reject discards the whole draft.'}
          </span>
          <div className="row">
            <button className="btn primary" onClick={acceptDraft}>
              Accept
            </button>
            <button className="btn" onClick={rejectDraft}>
              Reject
            </button>
          </div>
        </div>
      )}
      {steps.length > 0 && (
        <ol className="auto-steps">
          {steps
            .filter((s) => s.status !== 'skipped')
            .map((s) => (
              <StepRow key={s.key} run={s} review={Boolean(ownDraft)} bridge={isBridgeRun} />
            ))}
        </ol>
      )}
    </section>
  );
}
