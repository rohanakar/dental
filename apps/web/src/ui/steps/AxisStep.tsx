import { useDesignStore, selectActiveTooth } from '../../design/store';
import { axisTool } from '../../tools/axisTool';
import { useToolStore } from '../../tools/toolStore';

export function AxisStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const report = useToolStore((s) => s.axisReport);
  const busy = useToolStore((s) => s.busy);
  if (!tooth) return null;
  if (!tooth.margin) return <div className="step-body warning">Draw the margin first.</div>;
  const axis = tooth.axis;

  return (
    <div className="step-body">
      <p className="muted">
        The insertion axis is the direction the crown is seated along. Colours show where the prep is hidden from that
        direction; those areas are blocked out in the crown's inner surface.
      </p>
      <div className="row wrap">
        <button className="btn primary" disabled={Boolean(busy)} onClick={() => void axisTool.search()}>
          Least undercut
        </button>
        <button className="btn" disabled={Boolean(busy)} onClick={() => axisTool.fromView()} title="Look down onto the prep, then click">
          From view
        </button>
      </div>
      {axis && (
        <div className="tilt-pad" role="group" aria-label="Tilt the axis by 1°">
          <span />
          <button className="btn" aria-label="Tilt the axis 1° buccal" onClick={() => axisTool.tilt('buccal')}>Buccal</button>
          <span />
          <button className="btn" aria-label="Tilt the axis 1° mesial" onClick={() => axisTool.tilt('mesial')}>Mesial</button>
          <span className="muted">1°</span>
          <button className="btn" aria-label="Tilt the axis 1° distal" onClick={() => axisTool.tilt('distal')}>Distal</button>
          <span />
          <button className="btn" aria-label="Tilt the axis 1° lingual" onClick={() => axisTool.tilt('lingual')}>Lingual</button>
          <span />
        </div>
      )}
      {axis && report && (
        <dl className="params">
          <dt>Source</dt>
          <dd>{axis.source === 'auto' ? 'least undercut' : 'edited'}</dd>
          <dt>Tilt from occlusal</dt>
          <dd>{report.angleFromOcclusalDeg.toFixed(1)}°</dd>
          <dt>Undercut area</dt>
          <dd>{report.undercutAreaMm2.toFixed(2)} mm²</dd>
          <dt>Deepest undercut</dt>
          <dd>{report.maxDepthMm.toFixed(2)} mm</dd>
        </dl>
      )}
      {report && !report.prepClosed && (
        <div className="warning">The prep region leaked past the margin. Check that the margin is a closed loop on the prep.</div>
      )}
      {report && report.marginUndercutCount > 0 && (
        <div className="warning">
          The margin is in an undercut at {report.marginUndercutCount} of {report.marginPointCount} points (red dots). The crown
          cannot seat there along this axis. Tilt the axis or adjust the margin.
        </div>
      )}
    </div>
  );
}
