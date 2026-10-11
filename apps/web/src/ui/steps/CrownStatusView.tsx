import { useToolStore } from '../../tools/toolStore';

/** Crown computation state, validation and warnings (shared by the proposal and finalize steps). */
export function CrownStatusView({ detailed = false }: { detailed?: boolean }) {
  const crown = useToolStore((s) => s.crown);
  if (!crown) return null;
  const v = crown.validation;
  return (
    <>
      {crown.computing && (
        <div className="row muted">
          <span className="spinner" /> Computing the crown…
        </div>
      )}
      {crown.error && <div className="error">{crown.error}</div>}
      {v && (
        <dl className="params">
          <dt>Template</dt>
          <dd>{crown.templateId}</dd>
          <dt>Triangles</dt>
          <dd>{crown.triangles?.toLocaleString()}</dd>
          <dt>Watertight</dt>
          <dd className={v.ok ? 'ok' : 'bad'}>{v.ok ? 'yes' : 'no'}</dd>
          {detailed && (
            <>
              <dt>Open edges</dt>
              <dd>{v.boundaryEdges}</dd>
              <dt>Non-manifold edges</dt>
              <dd>{v.nonManifoldEdges}</dd>
              <dt>Flipped edges</dt>
              <dd>{v.inconsistentEdges}</dd>
              <dt>Self-intersections</dt>
              <dd className={v.selfIntersections ? 'bad' : v.selfIntersections === 0 ? 'ok' : ''}>{v.selfIntersections ?? '—'}</dd>
              <dt>Printable</dt>
              <dd className={v.printable ? 'ok' : 'bad'}>{v.printable === undefined ? '—' : v.printable ? 'yes' : 'no'}</dd>
              <dt>Volume</dt>
              <dd>{v.signedVolumeMm3.toFixed(1)} mm³</dd>
            </>
          )}
          {crown.thickness && crown.thickness.pushedVertices > 0 && (
            <>
              <dt>Thickness enforced</dt>
              <dd>
                {crown.thickness.pushedVertices} vertices, up to {crown.thickness.maxPushMm.toFixed(2)} mm
              </dd>
            </>
          )}
          <dt>Min. axial thickness</dt>
          <dd>{Number.isFinite(crown.minAxialThicknessMm) ? `${crown.minAxialThicknessMm!.toFixed(2)} mm` : '—'}</dd>
          {detailed && crown.gapCheck && crown.gapCheck.samples > 0 && (
            <>
              <dt>Cement gap error</dt>
              <dd>
                {(crown.gapCheck.meanErrorMm * 1000).toFixed(1)} µm mean, {(crown.gapCheck.maxErrorMm * 1000).toFixed(1)} µm max
              </dd>
            </>
          )}
          {crown.ms !== undefined && (
            <>
              <dt>Computed in</dt>
              <dd>{Math.round(crown.ms)} ms</dd>
            </>
          )}
        </dl>
      )}
      {crown.warnings.map((w) => (
        <div className="warning" key={w}>
          {w}
        </div>
      ))}
    </>
  );
}
