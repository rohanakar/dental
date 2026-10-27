import { unitKind } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { axisTool } from '../../tools/axisTool';
import { findMargins } from '../../tools/autoMargins';
import { useToolStore } from '../../tools/toolStore';
import { NeedsFirst } from '../StepFooter';
import { BridgeAxisReport, useActiveBridge } from './BridgePanels';
import { ImplantAxisPanel, useIsImplant } from './ImplantPanel';

export function AxisStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const pontic = useDesignStore((s) => unitKind(s.doc.setup, s.activeFdi) === 'pontic');
  const setup = useDesignStore((s) => s.doc.setup);
  const teeth = useDesignStore((s) => s.doc.teeth);
  const bridge = useActiveBridge();
  const report = useToolStore((s) => s.axisReport);
  const busy = useToolStore((s) => s.busy);
  const implant = useIsImplant();
  if (!tooth) return null;
  if (implant) return <ImplantAxisPanel />;
  if (pontic) return <div className="step-body muted">Pontic {tooth.fdi} has no prep: it follows the bridge's common insertion axis.</div>;
  // A bridge seats as one piece: one axis over every abutment, searched over all their preps.
  const common = bridge ? bridge.teeth.filter((f) => unitKind(setup, f) === 'abutment') : [];
  const missing = common.filter((f) => !teeth.find((t) => t.fdi === f)?.margin);
  if (!tooth.margin) return <NeedsFirst>Draw the margin first.</NeedsFirst>;
  const axis = tooth.axis;

  return (
    <div className="step-body">
      <p className="muted">
        {common.length > 1
          ? `The bridge seats along one axis, common to ${common.join(' and ')}. Coloured areas are hidden from it and get blocked out.`
          : 'The direction the crown seats along. Coloured areas are hidden from it and get blocked out.'}
      </p>
      {missing.length > 0 && (
        <div className="warning">
          The common axis is searched over every abutment: {missing.join(', ')} {missing.length === 1 ? 'has' : 'have'} no margin yet.{' '}
          <button type="button" className="link-btn" disabled={Boolean(busy)} onClick={() => void findMargins(missing)}>
            Find {missing.length === 1 ? 'it' : 'them'}
          </button>
        </div>
      )}
      <div className="row wrap">
        <button className={`btn${axis || missing.length > 0 ? '' : ' primary'}`} disabled={Boolean(busy) || missing.length > 0} onClick={() => void axisTool.search()}>
          {common.length > 1 ? 'Least undercut, common' : 'Least undercut'}
        </button>
        <button className="btn" disabled={Boolean(busy)} onClick={() => axisTool.fromView()} title="Look down onto the prep the way the crown should go on, then click">
          Along my view
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
          <dt>Tilt from {report.bridge ? 'mean occlusal' : 'occlusal'}</dt>
          <dd>{report.angleFromOcclusalDeg.toFixed(1)}°</dd>
          <dt>Undercut area{report.bridge ? ', all preps' : ''}</dt>
          <dd>{report.undercutAreaMm2.toFixed(2)} mm²</dd>
          <dt>Deepest undercut</dt>
          <dd>{report.maxDepthMm.toFixed(2)} mm</dd>
        </dl>
      )}
      {axis && report?.bridge && <BridgeAxisReport report={report} />}
      {report && !report.prepClosed && (
        <div className="warning">
          {report.bridge
            ? `The prep region of ${report.bridge.abutments
                .filter((a) => !a.prepClosed)
                .map((a) => a.fdi)
                .join(', ')} leaked past its margin, so the common axis is not reliable. Check that each margin is a closed loop on its prep.`
            : 'The prep region leaked past the margin. Check that the margin is a closed loop on the prep.'}
        </div>
      )}
      {report && report.marginUndercutCount > 0 && (
        <div className="warning">
          {report.bridge
            ? `The margin is in an undercut on ${report.bridge.abutments
                .filter((a) => a.marginUndercutCount > 0)
                .map((a) => `${a.fdi} (${a.marginUndercutCount} of ${a.marginPointCount} points)`)
                .join(', ')} (red dots). The bridge cannot seat along this axis. Tilt the axis or adjust the margin.`
            : `The margin is in an undercut at ${report.marginUndercutCount} of ${report.marginPointCount} points (red dots). The crown cannot seat there along this axis. Tilt the axis or adjust the margin.`}
        </div>
      )}
    </div>
  );
}
