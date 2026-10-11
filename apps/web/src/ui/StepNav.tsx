import type { StepId, StepStatus } from '@dcad/shared';
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

const STATUS_ICON: Record<StepStatus, string> = { pending: '○', done: '●', stale: '◐' };
const STATUS_TITLE: Record<StepStatus, string> = {
  pending: 'Not done yet',
  done: 'Done',
  stale: 'Out of date: an earlier step changed',
};

export function StepNav() {
  const activeStep = useDesignStore((s) => s.activeStep);
  const steps = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === s.activeFdi)?.steps);
  const teeth = useDesignStore((s) => s.doc.setup.teeth);
  const activeFdi = useDesignStore((s) => s.activeFdi);
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
          const status = steps?.[id] ?? 'pending';
          return (
            <li key={id}>
              <button
                type="button"
                className={`step${id === activeStep ? ' active' : ''} ${status}`}
                disabled={!available}
                aria-current={id === activeStep ? 'step' : undefined}
                title={available ? STATUS_TITLE[status] : 'Coming in a later milestone'}
                onClick={() => setActiveStep(id)}
              >
                <span className="step-icon" aria-hidden>
                  {STATUS_ICON[status]}
                </span>
                {label}
                {status === 'stale' && <span className="badge stale">stale</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
