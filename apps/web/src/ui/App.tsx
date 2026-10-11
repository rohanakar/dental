import { useEffect } from 'react';
import { useDesignStore } from '../design/store';
import { sceneController } from '../state/sceneController';
import { useSceneStore } from '../state/sceneStore';
import { marginTool } from '../tools/marginTool';
import { handleNudgeKey } from '../tools/nudge';
import { useToolStore } from '../tools/toolStore';
import { SessionGate } from './session/SessionGate';
import { StepNav, STEPS } from './StepNav';
import { AdaptStep } from './steps/AdaptStep';
import { AxisStep } from './steps/AxisStep';
import { FrameStep } from './steps/FrameStep';
import { FinalizeStep } from './steps/FinalizeStep';
import { MarginStep } from './steps/MarginStep';
import { ParamsStep } from './steps/ParamsStep';
import { ProposalStep } from './steps/ProposalStep';
import { ScansStep } from './steps/ScansStep';
import { SetupStep } from './steps/SetupStep';
import { ToolStatus } from './ToolStatus';
import { Toolbar, VIEWS } from './Toolbar';
import { Viewport } from './Viewport';

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
          if (key === 'y' || e.shiftKey) design.redo();
          else design.undo();
        }
        return;
      }
      if (e.altKey) return;
      if (design.activeStep === 'margin') {
        const drafting = useToolStore.getState().marginAnchors.length > 0;
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
  const label = STEPS.find((s) => s.id === step)?.label ?? step;
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
      <ToolStatus />
    </section>
  );
}

export function App() {
  useKeyboardShortcuts();
  return (
    <SessionGate>
      <div className="app">
        <Toolbar />
        <aside className="panel">
          <StepNav />
          <StepPanel />
        </aside>
        <Viewport />
      </div>
    </SessionGate>
  );
}
