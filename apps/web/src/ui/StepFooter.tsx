import { stepsFor, unitKind, type StepId } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import { STEPS } from './StepNav';
import { missingBefore, neighbours } from './stepGuide';
import './StepFooter.css';

const labelOf = (id: StepId) => STEPS.find((s) => s.id === id)?.label ?? id;

/** Back / Next under the step panel, and the way to an earlier step this one still needs. */
export function StepFooter() {
  const step = useDesignStore((s) => s.activeStep);
  const statuses = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === s.activeFdi)?.steps);
  const kind = useDesignStore((s) => unitKind(s.doc.setup, s.activeFdi));
  const { setActiveStep } = useDesignStore.getState();
  const steps = stepsFor(kind);
  const { prev, next } = neighbours(step, steps);
  const missing = missingBefore(step, statuses, steps);
  // Setup and parameters start from presets, so moving on from them is always the expected action.
  const ready = !missing && (statuses?.[step] === 'done' || step === 'setup' || step === 'params');

  return (
    <footer className="step-footer" aria-label="Step navigation">
      {missing && (
        <div className="step-missing">
          <span>This step needs {labelOf(missing)} first.</span>
          <button type="button" className="btn primary" onClick={() => setActiveStep(missing)}>
            Go to {labelOf(missing)}
          </button>
        </div>
      )}
      <div className="step-footer-nav">
        {prev && (
          <button type="button" className="btn ghost" onClick={() => setActiveStep(prev)}>
            Back
          </button>
        )}
        {next && (
          <button type="button" className={`btn step-next${ready ? ' primary' : ''}`} onClick={() => setActiveStep(next)}>
            Next: {labelOf(next)}
          </button>
        )}
      </div>
    </footer>
  );
}
