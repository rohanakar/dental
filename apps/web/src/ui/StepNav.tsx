import type { StepId, StepStatus } from '@dcad/shared';
import { useOrchestrator } from '../ai/orchestrator';
import { useDesignStore } from '../design/store';

export const STEPS: Array<{ id: StepId; label: string; available: boolean }> = [
  { id: 'setup', label: 'Case setup', available: true },
  { id: 'scans', label: 'Scans', available: true },
  { id: 'frame', label: 'Tooth frame', available: true },
  { id: 'margin', label: 'Margin', available: true },
  { id: 'axis', label: 'Insertion axis', available: true },
  { id: 'params', label: 'Parameters', available: true },
  { id: 'proposal', label: 'Crown proposal', available: true },
  { id: 'adapt', label: 'Adapt', available: true },
  { id: 'finalize', label: 'Finalize', available: true },
];

type NavStatus = StepStatus | 'draft';

const STATUS_TEXT: Record<NavStatus, string> = {
  pending: 'not done yet',
  done: 'done',
  stale: 'out of date: an earlier step changed',
  draft: 'in an open auto-design draft: accept or reject it',
};

export function StepNav() {
  const activeStep = useDesignStore((s) => s.activeStep);
  const steps = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === s.activeFdi)?.steps);
  const teeth = useDesignStore((s) => s.doc.setup.teeth);
  const activeFdi = useDesignStore((s) => s.activeFdi);
  // Steps an auto-design draft changed are not done until the draft is accepted.
  const drafted = useOrchestrator((s) => (s.pendingReview ? s.steps : null));
  const { setActiveStep, setActiveFdi } = useDesignStore.getState();

  return (
    <nav className="steps" aria-label="Design steps">
      {teeth.length > 1 && (
        <div className="field">
          <label htmlFor="active-tooth">Tooth</label>
          <select id="active-tooth" value={activeFdi} onChange={(e) => setActiveFdi(Number(e.target.value))}>
            {teeth.map((t) => (
              <option key={t.fdi} value={t.fdi}>
                {t.fdi}
              </option>
            ))}
          </select>
        </div>
      )}
      <ol>
        {STEPS.map(({ id, label, available }) => {
          const inDraft = drafted?.some((r) => r.step === id && (r.status === 'passed' || r.status === 'failed'));
          const status: NavStatus = inDraft ? 'draft' : (steps?.[id] ?? 'pending');
          return (
            <li key={id}>
              <button
                type="button"
                className={`step${id === activeStep ? ' active' : ''} ${status}`}
                disabled={!available}
                aria-current={id === activeStep ? 'step' : undefined}
                onClick={() => setActiveStep(id)}
              >
                <span className="step-label">{label}</span>
                {status === 'stale' && <span className="badge stale">stale</span>}
                {status === 'draft' && <span className="badge draft">draft</span>}
                <span className="step-icon" aria-hidden />
                <span className="visually-hidden">, {available ? STATUS_TEXT[status] : 'coming in a later milestone'}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
