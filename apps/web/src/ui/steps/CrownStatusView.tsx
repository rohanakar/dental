import { selectActiveTooth, useDesignStore } from '../../design/store';
import { useToolStore } from '../../tools/toolStore';

/**
 * The crown's result: computing state, whether it is a closed solid and its
 * thinnest point against the material minimum, plus warnings. `detailed`
 * (finalize) adds the mesh internals in a disclosure.
 */
export function CrownStatusView({ detailed = false }: { detailed?: boolean }) {
  const crown = useToolStore((s) => s.crown);
  const minThickness = useDesignStore((s) => selectActiveTooth(s)?.params.minThicknessMm);
  if (!crown) return null;
  const v = crown.validation;
  const thinnest = crown.thickness?.minMm ?? crown.minAxialThicknessMm;
  const thinOk = thinnest !== undefined && minThickness !== undefined && thinnest >= minThickness - 0.02;
  return (
    <>
      {crown.computing && (
        <div className="row muted" role="status">
          <span className="spinner" /> Computing the crown…
        </div>
      )}
      {crown.error && (
        <div className="error" role="alert">
          {crown.error}
        </div>
      )}
      {v && !detailed && (
        <dl className="params">
          <dt>Watertight</dt>
          <dd className={v.ok ? 'ok' : 'bad'}>{v.ok ? 'yes' : 'no'}</dd>
          <dt>Thinnest point</dt>
          <dd className={thinnest === undefined || !Number.isFinite(thinnest) ? '' : thinOk ? 'ok' : 'bad'}>
            {thinnest !== undefined && Number.isFinite(thinnest) ? `${thinnest.toFixed(2)} mm` : '—'}
            {minThickness !== undefined && <span className="muted"> / min {minThickness.toFixed(2)}</span>}
          </dd>
        </dl>
      )}
      {v && detailed && (
        <details className="mesh-details">
          <summary>Mesh details</summary>
          <dl className="params">
            <dt>Triangles</dt>
            <dd>{crown.triangles?.toLocaleString()}</dd>
            <dt>Open edges</dt>
            <dd>{v.boundaryEdges}</dd>
            <dt>Non-manifold edges</dt>
            <dd>{v.nonManifoldEdges}</dd>
            <dt>Flipped edges</dt>
            <dd>{v.inconsistentEdges}</dd>
            <dt>Self-intersections</dt>
            <dd>{v.selfIntersections ?? '—'}</dd>
            <dt>Volume</dt>
            <dd>{v.signedVolumeMm3.toFixed(1)} mm³</dd>
            {crown.thickness && crown.thickness.pushedVertices > 0 && (
              <>
                <dt>Thickness enforced</dt>
                <dd>
                  {crown.thickness.pushedVertices} vertices, up to {crown.thickness.maxPushMm.toFixed(2)} mm
                </dd>
              </>
            )}
            {crown.gapCheck && crown.gapCheck.samples > 0 && (
              <>
                <dt>Cement gap error</dt>
                <dd>
                  {(crown.gapCheck.meanErrorMm * 1000).toFixed(1)} µm mean, {(crown.gapCheck.maxErrorMm * 1000).toFixed(1)} µm max
                </dd>
              </>
            )}
            <dt>Template</dt>
            <dd>{crown.templateId}</dd>
          </dl>
        </details>
      )}
      {crown.warnings.map((w) => (
        <div className="warning" key={w}>
          {w}
        </div>
      ))}
    </>
  );
}
