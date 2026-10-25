import { useDesignStore, selectActiveTooth } from '../../design/store';
import { crownTool } from '../../tools/crownTool';
import { useToolStore } from '../../tools/toolStore';
import { AutoDesign } from '../ai/AutoDesign';
import { CrownStatusView } from './CrownStatusView';
import { FocusControls, MapSelect } from './CrownViewControls';
import { NudgePad } from './NudgePad';

/** Crown proposal, in working order: propose, read the result, adjust, then change how it is shown. */
export function ProposalStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const computing = useToolStore((s) => s.crown?.computing ?? false);
  const visible = useToolStore((s) => s.crownVisible);
  const opacity = useToolStore((s) => s.crownOpacity);
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
        <button className={`btn${hasCrown ? '' : ' primary'}`} disabled={computing} onClick={() => void crownTool.propose()}>
          {hasCrown ? 'Re-propose crown' : 'Propose crown'}
        </button>
      </div>
      <AutoDesign compact primary={false} />
      {hasCrown && (
        <>
          <CrownStatusView />
          <NudgePad />
          <fieldset className="view-controls">
            <legend>View</legend>
            <label className="row muted">
              <input type="checkbox" checked={visible} onChange={(e) => crownTool.setVisible(e.target.checked)} />
              Show crown
            </label>
            <MapSelect />
            <div className="row">
              <span className="muted">Crown opacity</span>
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
            <FocusControls />
          </fieldset>
        </>
      )}
      {!hasCrown && <CrownStatusView />}
    </div>
  );
}
