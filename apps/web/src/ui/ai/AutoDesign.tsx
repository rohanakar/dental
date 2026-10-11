import { useDesignStore, selectActiveTooth } from '../../design/store';
import { accept, reject, runAutoDesign, useOrchestrator, type StepRunStatus } from '../../ai/orchestrator';
import './AutoDesign.css';

type V3 = [number, number, number];

const STEP_LABEL: Record<string, string> = {
  frame: 'Tooth frame',
  margin: 'Margin',
  axis: 'Insertion axis',
  proposal: 'Crown',
  adapt: 'Adapt',
};

const STATUS_ICON: Record<StepRunStatus, string> = {
  pending: '○',
  running: '◌',
  passed: '✓',
  failed: '✗',
  skipped: '–',
};

/**
 * One-click crown: runs the classical proposers with QA gates and shows the
 * draft for review. `seed` (a click on the prep) lets it start from the tooth
 * frame; without it the tooth must already have a frame.
 */
export function AutoDesign({ seed, compact = false }: { seed?: V3; compact?: boolean }) {
  const tooth = useDesignStore(selectActiveTooth);
  const transaction = useDesignStore((s) => s.transaction);
  const { running, steps, pendingReview, complete, error } = useOrchestrator();
  const canStart = Boolean(tooth && (tooth.frame || seed)) && !running && !transaction;
  const ownDraft = pendingReview && transaction?.author === 'proposer';

  return (
    <section className={`auto-design${ownDraft ? ' review' : ''}`} aria-label="Auto-design">
      {!compact && (
        <p className="muted">
          Proposes the margin, insertion axis, crown and adaptation in one go. Each step must pass its checks; you review
          the result before anything is kept.
        </p>
      )}
      <div className="row">
        <button className="btn primary" disabled={!canStart} onClick={() => void runAutoDesign(seed ? { seed } : {})}>
          {running ? 'Designing…' : 'Auto-design crown'}
        </button>
        {!tooth?.frame && !seed && <span className="muted small">Set the tooth frame first (one click on the prep).</span>}
      </div>
      {error && <div className="warning">{error}</div>}
      {steps.length > 0 && (
        <ol className="auto-steps">
          {steps
            .filter((s) => s.status !== 'skipped')
            .map((s) => (
              <li key={s.step} className={s.status}>
                <span className="auto-icon" aria-hidden>
                  {s.status === 'running' ? <span className="spinner" /> : STATUS_ICON[s.status]}
                </span>
                <span className="auto-label">{STEP_LABEL[s.step] ?? s.step}</span>
                {s.ms !== undefined && <span className="muted small">{Math.round(s.ms)} ms</span>}
                {s.status === 'failed' && (
                  <ul className="auto-failures">
                    {s.qa
                      .filter((c) => !c.passed)
                      .map((c) => (
                        <li key={c.id}>
                          {c.message}
                          {c.value !== undefined && ` (${c.value}${c.threshold !== undefined ? ` vs ${c.threshold}` : ''})`}
                        </li>
                      ))}
                  </ul>
                )}
                {s.status === 'passed' && s.rationale && !compact && <div className="muted small auto-rationale">{s.rationale}</div>}
              </li>
            ))}
        </ol>
      )}
      {ownDraft && (
        <div className="auto-banner" role="status">
          <span>
            {complete ? 'Draft ready: every check passed.' : 'Stopped at a failed check. The steps before it are on screen.'}
          </span>
          <div className="row">
            <button className="btn primary" onClick={accept}>
              Accept
            </button>
            <button className="btn" onClick={reject}>
              Reject
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
