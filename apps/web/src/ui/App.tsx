import { stepsFor, unitKind } from '@dcad/shared';
import { useEffect } from 'react';
import { useDesignStore } from '../design/store';
import { sceneController } from '../state/sceneController';
import { useSceneStore } from '../state/sceneStore';
import { useSessionStore } from '../state/session';
import { marginTool, OFFSET_STEP_MM } from '../tools/marginTool';
import { handleNudgeKey } from '../tools/nudge';
import { useToolStore } from '../tools/toolStore';
import { AssistantPanel } from './ai/AssistantPanel';
import { toggleHelp, useHelp } from './HelpSheet';
import { redo, undo } from './history';
import { SessionGate } from './session/SessionGate';
import { StepFooter } from './StepFooter';
import { StepNav, stepLabel, useImplantLabels } from './StepNav';
import { AdaptStep } from './steps/AdaptStep';
import { AxisStep } from './steps/AxisStep';
import { FrameStep } from './steps/FrameStep';
import { FinalizeStep } from './steps/FinalizeStep';
import { MarginStep } from './steps/MarginStep';
import { ParamsStep } from './steps/ParamsStep';
import { ProposalStep } from './steps/ProposalStep';
import { ScansStep } from './steps/ScansStep';
import { SetupStep } from './steps/SetupStep';
import { useEditorTheme } from './theme';
import { Toolbar, VIEWS } from './Toolbar';
import { Viewport } from './Viewport';
import { stepLabelFor } from './steps/WingPanel';

function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
}

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const design = useDesignStore.getState();
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          e.preventDefault();
          if (key === 'y' || e.shiftKey) redo();
          else undo();
        }
        return;
      }
      if (e.altKey) return;
      if (e.key === '?') {
        toggleHelp();
        return;
      }
      if (e.key === 'Escape' && useHelp.getState().open) {
        toggleHelp(false);
        return;
      }
      if (design.activeStep === 'margin') {
        const tools = useToolStore.getState();
        const drafting = tools.marginAnchors.length > 0;
        const closed = !drafting && !tools.sectionRedraw && Boolean(design.doc.teeth.find((t) => t.fdi === design.activeFdi)?.margin);
        if (e.key === 'Backspace' && drafting) {
          e.preventDefault();
          marginTool.undoAnchor();
          return;
        }
        if (e.key === 'Enter' && drafting) {
          void marginTool.close();
          return;
        }
        if (e.key === 'Escape') {
          marginTool.cancel();
          return;
        }
        // A closed margin (specs/2026-10-27-margin-review-ux.md): Enter moves on, N / Shift+N go to the doubtful
        // parts, [ and ] lower and raise the whole line, Delete removes the point under the cursor.
        if (closed && e.key === 'Enter') {
          const steps = stepsFor(unitKind(design.doc.setup, design.activeFdi));
          const next = steps[steps.indexOf('margin') + 1];
          if (next) design.setActiveStep(next);
          return;
        }
        if (closed && (e.key === 'n' || e.key === 'N')) {
          marginTool.nextDoubt(e.shiftKey ? -1 : 1);
          return;
        }
        if (closed && (e.key === '[' || e.key === ']')) {
          void marginTool.offset(e.key === ']' ? OFFSET_STEP_MM : -OFFSET_STEP_MM);
          return;
        }
        if (closed && (e.key === 'Delete' || e.key === 'Backspace')) {
          e.preventDefault();
          void marginTool.deleteHovered();
          return;
        }
      }
      if (design.activeStep === 'proposal' && handleNudgeKey(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && design.activeStep === 'frame') useToolStore.getState().set({ framePick: 'seed' });
      const view = VIEWS.find((v) => v.key === e.key);
      if (view) sceneController.setView(view.view);
      else if (e.key === 'f' || e.key === 'F') sceneController.fit();
      else if (e.key === 'o' || e.key === 'O') {
        const p = useSceneStore.getState().projection;
        sceneController.setProjection(p === 'perspective' ? 'orthographic' : 'perspective');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function StepPanel() {
  const step = useDesignStore((s) => s.activeStep);
  // The assistant needs the server; offline it only says so, so start it closed.
  const offline = useSessionStore((s) => s.offline);
  const implantLabels = useImplantLabels();
  const wingLabel = useDesignStore((s) => stepLabelFor(s.doc.setup, s.activeFdi, step, ''));
  const label = wingLabel || stepLabel(step, implantLabels);
  return (
    <section className="step-panel">
      <h2>{label}</h2>
      {step === 'setup' && <SetupStep />}
      {step === 'scans' && <ScansStep />}
      {step === 'frame' && <FrameStep />}
      {step === 'margin' && <MarginStep />}
      {step === 'axis' && <AxisStep />}
      {step === 'params' && <ParamsStep />}
      {step === 'proposal' && <ProposalStep />}
      {step === 'adapt' && <AdaptStep />}
      {step === 'finalize' && <FinalizeStep />}
      {(step === 'proposal' || step === 'adapt') && (
        <details className="assistant-section" open={!offline}>
          <summary>Design assistant</summary>
          <AssistantPanel />
        </details>
      )}
    </section>
  );
}

/** The editor's own theme (light unless the user turned dark on); the session screens stay light. */
function EditorTheme() {
  useEditorTheme();
  return null;
}

export function App() {
  useKeyboardShortcuts();
  const setup = useDesignStore((s) => s.activeStep === 'setup');
  return (
    <SessionGate>
      <div className={`app${setup ? ' wide-panel' : ''}`}>
        <EditorTheme />
        <Toolbar />
        <aside className="panel">
          <StepNav />
          <StepPanel />
          <StepFooter />
        </aside>
        <Viewport />
      </div>
    </SessionGate>
  );
}
