import type { StandardView } from '../engine/viewFrame';
import { sceneController } from '../state/sceneController';
import { useSceneStore } from '../state/sceneStore';

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

  return (
    <header className="toolbar">
      <span className="brand">Dental CAD</span>
      <div className="group" role="group" aria-label="Standard views">
        {VIEWS.map(({ view, label, key }) => (
          <button key={view} className="btn" disabled={!hasReady} title={`${label} view (${key})`} onClick={() => sceneController.setView(view)}>
            {label}
          </button>
        ))}
        <button className="btn" disabled={!hasReady} title="Fit to scene (F)" onClick={() => sceneController.fit()}>
          Fit
        </button>
      </div>
      <span className="sep" />
      <div className="group" role="group" aria-label="Projection">
        <button
          className={`btn${projection === 'perspective' ? ' active' : ''}`}
          aria-pressed={projection === 'perspective'}
          onClick={() => sceneController.setProjection('perspective')}
        >
          Perspective
        </button>
        <button
          className={`btn${projection === 'orthographic' ? ' active' : ''}`}
          aria-pressed={projection === 'orthographic'}
          title="Orthographic (O toggles)"
          onClick={() => sceneController.setProjection('orthographic')}
        >
          Orthographic
        </button>
      </div>
      <span className="sep" />
      <button className="btn" disabled={!hasReady} onClick={() => void sceneController.screenshot()}>
        Screenshot
      </button>
    </header>
  );
}
