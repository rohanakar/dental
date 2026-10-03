import { sceneController } from '../state/sceneController';
import { useSceneStore, type SceneObjectState } from '../state/sceneStore';

const ROLE_LABEL: Record<SceneObjectState['role'], string> = {
  upper: 'Upper',
  lower: 'Lower',
  preop: 'Pre-op',
};

const fmt = (n: number) => n.toLocaleString();

function ObjectRow({ obj }: { obj: SceneObjectState }) {
  const busy = obj.phase === 'reading' || obj.phase === 'processing';
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
        <button className="btn ghost" title="Remove" aria-label={`Remove ${obj.name}`} onClick={() => sceneController.remove(obj.id)}>
          ✕
        </button>
      </div>

      {busy && (
        <div className="row muted">
          <span className="spinner" /> {obj.phase === 'reading' ? 'Reading file…' : 'Processing (weld, cleanup, BVH)…'}
        </div>
      )}
      {obj.phase === 'error' && <div className="error">{obj.error}</div>}

      {ready && obj.stats && (
        <>
          <div className="stats">
            {fmt(obj.stats.triangles)} triangles · {fmt(obj.stats.vertices)} vertices
            <br />
            {obj.stats.sizeMm.map((v) => v.toFixed(1)).join(' × ')} mm · {obj.stats.format}
            <br />
            processed in {Math.round(obj.stats.timingsMs.total + (obj.bvhMs ?? 0))} ms
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
      <h2>Objects</h2>
      <div className="objects">
        {objects.map((o) => (
          <ObjectRow key={o.id} obj={o} />
        ))}
      </div>
    </section>
  );
}
