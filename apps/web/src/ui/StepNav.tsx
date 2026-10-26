import { bridgeOf, STEP_ORDER, stepsFor, unitKind, type StepId, type StepStatus } from '@dcad/shared';
import { useEffect } from 'react';
import { useOrchestrator } from '../ai/orchestrator';
import { useDesignStore } from '../design/store';
import { isImplantTooth } from '../tools/implantTool';
import './bridge.css';
import { stepLabelFor, unitName } from './steps/WingPanel';

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

/** A step's label for the active unit: an implant crown's margin step is its implant position (the scan-body match). */
export const stepLabel = (id: StepId, implant: boolean): string =>
  id === 'margin' && implant ? 'Implant position' : (STEPS.find((s) => s.id === id)?.label ?? id);

/** Whether the active tooth is an implant crown (its margin step is labelled "Implant position"). */
export const useImplantLabels = (): boolean => useDesignStore((s) => isImplantTooth(s.doc, s.activeFdi));

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
  const setup = useDesignStore((s) => s.doc.setup);
  const bridges = useDesignStore((s) => s.doc.bridges);
  const activeFdi = useDesignStore((s) => s.activeFdi);
  // Steps an auto-design draft changed are not done until the draft is accepted.
  const drafted = useOrchestrator((s) => (s.pendingReview ? s.steps : null));
  const { setActiveStep, setActiveFdi } = useDesignStore.getState();

  // The step list follows the unit: a pontic has no prep, so no margin and no insertion axis.
  const kind = unitKind(setup, activeFdi);
  const visible = stepsFor(kind);
  const bridge = bridgeOf({ bridges }, activeFdi);
  const commonAxis = kind === 'abutment' && bridge ? bridge.teeth.filter((fdi) => unitKind(setup, fdi) === 'abutment') : [];

  // Switching to a pontic while on a step it does not have goes back to the closest step it has.
  useEffect(() => {
    const has = stepsFor(kind);
    if (has.includes(activeStep)) return;
    const earlier = STEP_ORDER.slice(0, STEP_ORDER.indexOf(activeStep)).filter((s) => has.includes(s));
    setActiveStep(earlier.at(-1) ?? has[0]!);
  }, [activeStep, kind, setActiveStep]);

  const unitLabel = (fdi: number) => {
    const b = bridgeOf({ bridges }, fdi);
    return `${fdi} · ${unitName(setup, fdi)}${b ? ` (${b.teeth[0]}–${b.teeth.at(-1)})` : ''}`;
  };

  return (
    <nav className="steps" aria-label="Design steps">
      {setup.teeth.length > 1 && (
        <div className="field">
          <label htmlFor="active-tooth">Tooth</label>
          <select id="active-tooth" value={activeFdi} onChange={(e) => setActiveFdi(Number(e.target.value))}>
            {setup.teeth.map((t) => (
              <option key={t.fdi} value={t.fdi}>
                {unitLabel(t.fdi)}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* Remounted per unit kind: Chrome keeps stale CSS step counters (1, 2, 3, 6…) when items are removed in place. */}
      <ol key={kind}>
        {STEPS.filter(({ id }) => visible.includes(id)).map(({ id, available }) => {
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
                <span className="step-label">
                  {stepLabelFor(setup, activeFdi, id, stepLabel(id, isImplantTooth({ setup }, activeFdi)))}
                  {id === 'axis' && commonAxis.length > 1 && <span className="step-note"> · common for {commonAxis.join(', ')}</span>}
                </span>
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
