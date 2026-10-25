import { sceneController } from '../state/sceneController';
import { useSceneStore, type SceneObjectState } from '../state/sceneStore';
import { CloseIcon } from './icons';

const ROLE_LABEL: Record<SceneObjectState['role'], string> = {
  upper: 'Upper',
  lower: 'Lower',
  preop: 'Pre-op',
};

const BUSY_LABEL: Partial<Record<SceneObjectState['phase'], string>> = {
  reading: 'Reading file…',
  processing: 'Preparing the scan…',
  uploading: 'Uploading to the case…',
};

const fmt = (n: number) => n.toLocaleString();

function ObjectRow({ obj }: { obj: SceneObjectState }) {
  const busy = obj.phase === 'reading' || obj.phase === 'processing' || obj.phase === 'uploading';
  const ready = obj.phase === 'ready';
  return (
    <div className="object">
      <div className="object-head">
        <input
          type="checkbox"
          aria-label={`Show ${obj.name}`}
          title="Visible"
          checked={obj.visible}
          disabled={!ready}
          onChange={(e) => sceneController.setVisible(obj.id, e.target.checked)}
        />
        <span className="object-name" title={obj.name}>
          {obj.name}
        </span>
        <span className="badge">{ROLE_LABEL[obj.role]}</span>
        <button className="btn ghost icon" title="Remove" aria-label={`Remove ${obj.name}`} onClick={() => sceneController.remove(obj.id)}>
          <CloseIcon />
        </button>
      </div>

      {busy && (
        <div className="row muted" role="status">
          <span className="spinner" /> {BUSY_LABEL[obj.phase]}
        </div>
      )}
      {obj.phase === 'error' && (
        <div className="error" role="alert">
          {obj.error}
        </div>
      )}

      {ready && obj.stats && (
        <>
          <div className="stats">
            {obj.stats.sizeMm.map((v) => v.toFixed(1)).join(' × ')} mm · {fmt(obj.stats.triangles)} triangles · {obj.stats.format}
          </div>
          <div className="row">
            <span className="muted">Opacity</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={obj.opacity}
              aria-label={`Opacity of ${obj.name}`}
              onChange={(e) => sceneController.setOpacity(obj.id, Number(e.target.value))}
            />
          </div>
          {obj.hasColors && (
            <label className="row muted">
              <input
                type="checkbox"
                checked={obj.useVertexColors}
                onChange={(e) => sceneController.setVertexColors(obj.id, e.target.checked)}
              />
              Show scan colors
            </label>
          )}
          {obj.warnings.map((w) => (
            <div className="warning" key={w}>
              {w}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function ObjectList() {
  const objects = useSceneStore((s) => s.objects);
  if (objects.length === 0) return null;
  return (
    <section>
      <h3>Objects</h3>
      <div className="objects">
        {objects.map((o) => (
          <ObjectRow key={o.id} obj={o} />
        ))}
      </div>
    </section>
  );
}
