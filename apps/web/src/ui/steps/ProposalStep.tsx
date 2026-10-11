import { useDesignStore, selectActiveTooth } from '../../design/store';
import { CROWN_MAPS, crownTool } from '../../tools/crownTool';
import type { CrownMapName } from '../../workers/analysisTypes';
import { useToolStore } from '../../tools/toolStore';
import { CrownStatusView } from './CrownStatusView';
import { NudgePad } from './NudgePad';

export function ProposalStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const computing = useToolStore((s) => s.crown?.computing ?? false);
  const visible = useToolStore((s) => s.crownVisible);
  const opacity = useToolStore((s) => s.crownOpacity);
  const map = useToolStore((s) => s.crownMap);
  if (!tooth) return null;
  if (!tooth.axis) return <div className="step-body warning">Set the insertion axis first.</div>;
  const hasCrown = Boolean(tooth.crown);

  return (
    <div className="step-body">
      <p className="muted">
        A library crown is placed on the margin in the tooth frame, sized to the gap between the neighbours and the space
        to the antagonist. The inner surface follows the prep with the cement gap.
      </p>
      <div className="row">
        <button className="btn primary" disabled={computing} onClick={() => void crownTool.propose()}>
          {hasCrown ? 'Re-propose crown' : 'Propose crown'}
        </button>
      </div>
      {hasCrown && (
        <>
          <label className="row muted">
            <input type="checkbox" checked={visible} onChange={(e) => crownTool.setVisible(e.target.checked)} />
            Show crown
          </label>
          <div className="field">
            <label htmlFor="crown-map">Colour map</label>
            <select id="crown-map" value={map} onChange={(e) => crownTool.setMap(e.target.value as CrownMapName | 'none')}>
              <option value="none">None</option>
              {(Object.keys(CROWN_MAPS) as CrownMapName[]).map((m) => (
                <option key={m} value={m}>
                  {CROWN_MAPS[m].title}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="muted">Opacity</span>
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={opacity}
              aria-label="Crown opacity"
              onChange={(e) => crownTool.setOpacity(Number(e.target.value))}
            />
          </div>
        </>
      )}
      {hasCrown && <NudgePad />}
      <CrownStatusView />
    </div>
  );
}
