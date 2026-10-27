import { stepsFor, unitKind, type StepId } from '@dcad/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useDesignStore } from '../design/store';
import { DraftReview, useDraftOpen } from './ai/AutoDesign';
import { stepLabel, useImplantLabels } from './StepNav';
import { missingBefore, neighbours } from './stepGuide';
import './StepFooter.css';
import { stepLabelFor } from './steps/WingPanel';
import { ToolStatus } from './ToolStatus';

/** The earliest required step before the active one that was never done: the footer names it. */
export function useMissingStep(): StepId | undefined {
  return useDesignStore((s) => missingBefore(s.activeStep, s.doc.teeth.find((t) => t.fdi === s.activeFdi)?.steps, stepsFor(unitKind(s.doc.setup, s.activeFdi))));
}

/** A panel's own "… first" line, shown only while the footer names no missing step: one message, the earliest. */
export function NeedsFirst({ children }: { children: ReactNode }) {
  return useMissingStep() ? null : <div className="step-body warning">{children}</div>;
}

/**
 * Whether the step panel shows its own primary action. One solid primary per step: while it does, the footer's
 * buttons are plain. The assistant is a form of its own, with its own primary, so it does not count.
 */
function usePanelPrimary(): boolean {
  const [own, setOwn] = useState(false);
  useEffect(() => {
    const panel = document.querySelector('.step-panel');
    if (!panel) return;
    const check = () => setOwn([...panel.querySelectorAll('.btn.primary')].some((b) => !b.closest('.assistant-section') && b.checkVisibility()));
    check();
    const observer = new MutationObserver(check);
    observer.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open', 'hidden'] });
    return () => observer.disconnect();
  }, []);
  return own;
}

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
  const missing = useMissingStep();
  const draftOpen = useDraftOpen();
  const panelPrimary = usePanelPrimary();
  // Setup and parameters start from presets, so moving on from them is always the expected action. An open draft is
  // decided first, and the panel's own primary comes first: nothing else looks like the next action.
  const ready = !draftOpen && !panelPrimary && !missing && (statuses?.[step] === 'done' || step === 'setup' || step === 'params');

  return (
    <footer className="step-footer" aria-label="Step navigation">
      <ToolStatus />
      <DraftReview />
      {missing && (
        <div className="step-missing">
          <span>This step needs {labelOf(missing)} first.</span>
          <button type="button" className={`btn${draftOpen || panelPrimary ? '' : ' primary'}`} onClick={() => setActiveStep(missing)}>
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
