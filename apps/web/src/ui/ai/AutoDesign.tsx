import type { QaCheck, StepId } from '@dcad/shared';
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

/**
 * When a draft opens for review, show what it made before the user decides:
 * a complete draft opens Crown proposal with the occlusion map on; a draft
 * that stopped opens the step whose check failed.
 */
useOrchestrator.subscribe((s, prev) => {
  if (!s.pendingReview || prev.pendingReview) return;
  const target: StepId = s.steps.find((r) => r.status === 'failed')?.step ?? 'proposal';
  const design = useDesignStore.getState();
  design.setActiveStep(target);
  if ((target === 'proposal' || target === 'adapt') && selectActiveTooth(design)?.crown) crownTool.setMap('occlusion');
});

function acceptDraft(): void {
  accept();
  useToolStore.getState().set({ message: { kind: 'info', text: 'Draft accepted. Undo takes it back in one step.' } });
}

function rejectDraft(): void {
  reject();
  useToolStore.getState().set({ message: { kind: 'info', text: 'Draft rejected. The design is back to where it was before auto-design.' } });
}

const num = (v: number) => Number(v.toFixed(2));
const checkValue = (c: QaCheck) =>
  c.value === undefined ? '' : c.threshold === undefined ? ` (${num(c.value)})` : ` (${num(c.value)}, limit ${num(c.threshold)})`;

function StepRow({ run, review }: { run: StepRun; review: boolean }) {
  const showChecks = run.status === 'failed' || (review && run.status === 'passed');
  return (
    <li className={run.status}>
      <span className="auto-icon">
        {run.status === 'running' ? <span className="spinner" /> : run.status === 'passed' ? <CheckIcon /> : run.status === 'failed' ? <FailIcon /> : <span className="auto-dot" />}
      </span>
      <span className="auto-label">
        {STEP_LABEL[run.step] ?? run.step}
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
 * One-click crown: runs the classical proposers with QA gates and shows the
 * draft for review. `seed` (a click on the prep) lets it start from the tooth
 * frame; without it the tooth must already have a frame. `primary` when it is
 * the step's main action.
 */
export function AutoDesign({ seed, compact = false, primary = true }: { seed?: V3; compact?: boolean; primary?: boolean }) {
  const tooth = useDesignStore(selectActiveTooth);
  const transaction = useDesignStore((s) => s.transaction);
  const { running, steps, pendingReview, complete, error } = useOrchestrator();
  const canStart = Boolean(tooth && (tooth.frame || seed)) && !running && !transaction;
  const ownDraft = pendingReview && transaction?.author === 'proposer';
  const failed = steps.find((s) => s.status === 'failed');

  return (
    <section className={`auto-design${ownDraft ? ' review' : ''}`} aria-label="Auto-design">
      {!ownDraft && (
        <>
          <div className="row">
            <button className={`btn${primary ? ' primary' : ''}`} disabled={!canStart} onClick={() => void runAutoDesign(seed ? { seed } : {})}>
              {running ? 'Designing…' : 'Auto-design crown'}
            </button>
            {!tooth?.frame && !seed && <span className="muted small">Set the tooth frame first (one click on the prep).</span>}
          </div>
          {!running && steps.length === 0 && (
            <p className="muted small">
              {compact
                ? 'Proposes margin, axis, crown and adaptation in one go; each must pass its checks, and you review before anything is kept.'
                : 'Proposes the margin, insertion axis, crown and adaptation in one go. Each step must pass its checks; you review the result before anything is kept.'}
            </p>
          )}
        </>
      )}
      {error && <div className="warning">{error}</div>}
      {ownDraft && (
        <div className="auto-banner" role="status">
          <strong>{complete ? 'Draft ready: every check passed' : `Draft stopped: ${STEP_LABEL[failed?.step ?? ''] ?? 'a step'} failed its check`}</strong>
          <span className="muted small">
            {complete
              ? 'The crown is on screen with the occlusion map. Accept keeps the whole draft as one undo step.'
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
              <StepRow key={s.step} run={s} review={Boolean(ownDraft)} />
            ))}
        </ol>
      )}
    </section>
  );
}
