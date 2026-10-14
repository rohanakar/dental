import { useDesignStore, selectActiveTooth } from '../../design/store';
import { crownTool } from '../../tools/crownTool';
import { useToolStore } from '../../tools/toolStore';
import { CrownStatusView } from './CrownStatusView';
import { ReadaptNotice } from './CrownViewControls';
import './NudgePad.css';

export function FinalizeStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const crown = useToolStore((s) => s.crown);
  if (!tooth) return null;
  if (!tooth.crown) return <div className="step-body warning">Propose a crown first.</div>;
  const ready = Boolean(crown && !crown.computing && crown.validation);
  const valid = Boolean(crown?.validation?.ok);

  return (
    <div className="step-body">
      <p className="muted">Exports a binary STL (mm) and a construction-info JSON with the margin, axis, parameters and checks.</p>
      {/* Exported as shown: re-adapt first if a later edit switched the adaptation off. */}
      <ReadaptNotice />
      <CrownStatusView detailed />
      {ready && !valid && <div className="warning">The mesh did not pass validation. Exporting anyway is possible but it may not mill.</div>}
      {ready && valid && crown?.validation?.printable === false && (
        <div className="warning">The crown intersects itself ({crown.validation.selfIntersections} triangle pairs). CAM software may reject it.</div>
      )}
      <div className="row">
        <button className="btn primary" disabled={!ready} onClick={() => crownTool.export('stl')}>
          Export STL
        </button>
        <button className="btn" disabled={!ready} onClick={() => crownTool.export('info')} title="Margin, axis, parameters, template pose and checks">
          Construction info
        </button>
      </div>
    </div>
  );
}
