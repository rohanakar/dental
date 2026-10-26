import { stepsFor, unitKind, type StepId } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import { DraftReview, useDraftOpen } from './ai/AutoDesign';
import { stepLabel, useImplantLabels } from './StepNav';
import { missingBefore, neighbours } from './stepGuide';
import './StepFooter.css';
import { stepLabelFor } from './steps/WingPanel';
import { ToolStatus } from './ToolStatus';

/** Back / Next under the step panel, and the way to an earlier step this one still needs. */
export function StepFooter() {
  const step = useDesignStore((s) => s.activeStep);
  const statuses = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === s.activeFdi)?.steps);
  const kind = useDesignStore((s) => unitKind(s.doc.setup, s.activeFdi));
  const { setActiveStep } = useDesignStore.getState();
  const implant = useImplantLabels();
  const labelOf = (id: StepId) => stepLabelFor(useDesignStore.getState().doc.setup, useDesignStore.getState().activeFdi, id, stepLabel(id, implant));
  const steps = stepsFor(kind);
  const { prev, next } = neighbours(step, steps);
  const missing = missingBefore(step, statuses, steps);
  const draftOpen = useDraftOpen();
  // Setup and parameters start from presets, so moving on from them is always the expected action. An open draft is
  // decided first: nothing else looks like the next action.
  const ready = !draftOpen && !missing && (statuses?.[step] === 'done' || step === 'setup' || step === 'params');

  return (
    <footer className="step-footer" aria-label="Step navigation">
      <ToolStatus />
      <DraftReview />
      {missing && (
        <div className="step-missing">
          <span>This step needs {labelOf(missing)} first.</span>
          <button type="button" className={`btn${draftOpen ? '' : ' primary'}`} onClick={() => setActiveStep(missing)}>
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
