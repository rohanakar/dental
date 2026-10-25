import { useDesignStore } from '../design/store';
import type { StandardView } from '../engine/viewFrame';
import { sceneController } from '../state/sceneController';
import { useSceneStore } from '../state/sceneStore';
import { CameraIcon, RedoIcon, UndoIcon } from './icons';
import { ProjectControls } from './session/ProjectControls';
import { SessionControls } from './session/SessionControls';

export const VIEWS: Array<{ view: StandardView; label: string; key: string }> = [
  { view: 'occlusal', label: 'Occlusal', key: '1' },
  { view: 'buccal', label: 'Buccal', key: '2' },
  { view: 'lingual', label: 'Lingual', key: '3' },
  { view: 'mesial', label: 'Mesial', key: '4' },
  { view: 'distal', label: 'Distal', key: '5' },
];

export function Toolbar() {
  const hasReady = useSceneStore((s) => s.objects.some((o) => o.phase === 'ready'));
  const projection = useSceneStore((s) => s.projection);
  // Undo/redo wait while a draft (auto-design or assistant) is open for review.
  const draftOpen = useDesignStore((s) => Boolean(s.transaction));
  const canUndo = useDesignStore((s) => s.past.length > 0) && !draftOpen;
  const canRedo = useDesignStore((s) => s.future.length > 0) && !draftOpen;
  const { undo, redo } = useDesignStore.getState();

  return (
    <header className="toolbar">
      <span className="brand">Dental CAD</span>
      <div className="group" role="group" aria-label="History">
        <button
          className="btn quiet icon"
          disabled={!canUndo}
          title={draftOpen ? 'Accept or reject the open draft first' : 'Undo (Ctrl/⌘+Z)'}
          aria-label="Undo"
          aria-keyshortcuts="Control+Z Meta+Z"
          onClick={undo}
        >
          <UndoIcon />
        </button>
        <button className="btn quiet icon" disabled={!canRedo} title="Redo (Shift+Ctrl/⌘+Z)" aria-label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" onClick={redo}>
          <RedoIcon />
        </button>
      </div>
      <span className="sep" />
      <div className="seg" role="group" aria-label="Standard views">
        {VIEWS.map(({ view, label, key }) => (
          <button key={view} className="btn" disabled={!hasReady} title={`${label} view (${key})`} aria-keyshortcuts={key} onClick={() => sceneController.setView(view)}>
            {label}
          </button>
        ))}
        <button className="btn" disabled={!hasReady} title="Fit to scene (F)" aria-keyshortcuts="F" onClick={() => sceneController.fit()}>
          Fit
        </button>
      </div>
      <button
        className="btn"
        aria-pressed={projection === 'orthographic'}
        title="Orthographic projection: distances read true (O). Off: perspective."
        aria-keyshortcuts="O"
        onClick={() => sceneController.setProjection(projection === 'orthographic' ? 'perspective' : 'orthographic')}
      >
        Orthographic
      </button>
      <button className="btn quiet icon" disabled={!hasReady} aria-label="Screenshot" title="Screenshot (PNG)" onClick={() => void sceneController.screenshot()}>
        <CameraIcon />
      </button>
      <span className="sep" />
      <ProjectControls />
      <SessionControls />
    </header>
  );
}
