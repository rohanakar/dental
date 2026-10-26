import { unitKind } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { bridgeTool, useBridgeStore } from '../../tools/bridgeTool';
import { crownTool } from '../../tools/crownTool';
import { useToolStore } from '../../tools/toolStore';
import { AutoDesign } from '../ai/AutoDesign';
import { BridgeResultPanel, useActiveBridge } from './BridgePanels';
import { CrownStatusView } from './CrownStatusView';
import { FocusControls, MapSelect } from './CrownViewControls';
import { MarginNotice } from './MarginIssues';
import { NudgePad } from './NudgePad';
import { isWing } from '../../tools/wing';
import { ScrewChannelPanel } from './ImplantPanel';

/** How the crown (or bridge) is shown: visibility, colour map, opacity and the focus view. */
function CrownView({ what }: { what: string }) {
  const visible = useToolStore((s) => s.crownVisible);
  const opacity = useToolStore((s) => s.crownOpacity);
  return (
    <fieldset className="view-controls">
      <legend>View</legend>
      <label className="row muted">
        <input type="checkbox" checked={visible} onChange={(e) => crownTool.setVisible(e.target.checked)} />
        Show {what}
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
  );
}

/** Crown proposal, in working order: propose, read the result, adjust, then change how it is shown. */
export function ProposalStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const bridge = useActiveBridge();
  const computing = useToolStore((s) => s.crown?.computing ?? false);
  if (!tooth) return null;
  if (bridge) return <BridgeProposal />;
  if (!tooth.axis) return <div className="step-body warning">Set the insertion axis first.</div>;
  const hasCrown = Boolean(tooth.crown);

  return (
    <div className="step-body">
      <p className="muted">
        {tooth.implant
          ? 'A library crown is placed on the gingiva around the implant, sized to the gap between the neighbours and the space to the antagonist. It is bonded to the Ti-base and screwed through its channel.'
          : 'A library crown is placed on the margin in the tooth frame, sized to the gap between the neighbours and the space to the antagonist. The inner surface follows the prep with the cement gap.'}
      </p>
      <MarginNotice />
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
          <ScrewChannelPanel />
          <CrownView what="crown" />
        </>
      )}
      {!hasCrown && <CrownStatusView />}
    </div>
  );
}

/**
 * The bridge proposal: every unit at once (retainers on their margins, pontics on the arch, all along the common
 * axis) as one undo entry; then the active unit is read and adjusted, as a single crown is.
 */
function BridgeProposal() {
  const bridge = useActiveBridge();
  const doc = useDesignStore((s) => s.doc);
  const activeFdi = useDesignStore((s) => s.activeFdi);
  const missing = useBridgeStore((s) => s.missing);
  const computing = useToolStore((s) => s.crown?.computing ?? false);
  const busy = useToolStore((s) => s.busy);
  if (!bridge) return null;
  const units = bridge.teeth.map((f) => doc.teeth.find((t) => t.fdi === f));
  const placed = units.some((t) => t?.crown);
  const kind = unitKind(doc.setup, activeFdi) === 'pontic' ? 'pontic' : 'crown';

  return (
    <div className="step-body">
      <p className="muted">
        Retainers are placed on the abutment margins and pontics on the arch between them, all along the common insertion
        axis. Connectors join the neighbouring units. Click a unit to adjust it.
      </p>
      {missing && !placed && <div className="warning">{missing}</div>}
      <MarginNotice />
      <div className="row">
        <button className={`btn${placed ? '' : ' primary'}`} disabled={computing || Boolean(busy) || Boolean(missing)} onClick={() => void bridgeTool.propose()}>
          {placed ? 'Re-propose bridge' : 'Propose bridge'}
        </button>
      </div>
      <AutoDesign compact primary={false} />
      {placed && (
        <>
          <BridgeResultPanel />
          <CrownStatusView />
          {isWing(doc.setup, activeFdi) ? <p className="muted small">The wing follows its outline: change the outline or its thickness.</p> : <NudgePad label={`Adjust ${activeFdi}, ${kind}`} />}
          <ScrewChannelPanel />
          <CrownView what="bridge" />
        </>
      )}
    </div>
  );
}
