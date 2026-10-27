import { outerSourceOf, unitKind } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { bridgeTool, useBridgeStore } from '../../tools/bridgeTool';
import { crownTool } from '../../tools/crownTool';
import { useToolStore } from '../../tools/toolStore';
import { AutoDesign } from '../ai/AutoDesign';
import { NeedsFirst } from '../StepFooter';
import { BridgeResultPanel, useActiveBridge } from './BridgePanels';
import { CrownStatusView } from './CrownStatusView';
import { FocusControls, MapSelect } from './CrownViewControls';
import { MarginNotice } from './MarginIssues';
import { NudgePad } from './NudgePad';
import { isWing } from '../../tools/wing';
import { ScrewChannelPanel } from './ImplantPanel';
import { inlayProposalText, OuterSourceSwitch, useCavityType, useFollowsPreop } from './InlayPanel';

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
  const cavity = useCavityType();
  const source = useDesignStore((s) => outerSourceOf(s.doc, s.activeFdi));
  const fixed = useFollowsPreop();
  if (!tooth) return null;
  if (bridge) return <BridgeProposal />;
  if (!tooth.axis) return <NeedsFirst>Set the insertion axis first.</NeedsFirst>;
  const hasCrown = Boolean(tooth.crown);

  return (
    <div className="step-body">
      <p className="muted">
        {cavity
          ? inlayProposalText(cavity, source)
          : tooth.implant
          ? 'A library crown, sized to the gap and the bite, on the Ti-base and screwed through its channel.'
          : 'A library crown, sized to the gap and the bite, seated on the margin.'}
      </p>
      <MarginNotice />
      <OuterSourceSwitch />
      <div className="row">
        <button className={`btn${hasCrown ? '' : ' primary'}`} disabled={computing} onClick={() => void crownTool.propose()}>
          {hasCrown ? `Re-propose ${cavity ?? 'crown'}` : `Propose ${cavity ?? 'crown'}`}
        </button>
      </div>
      <AutoDesign compact primary={false} />
      {hasCrown && (
        <>
          <CrownStatusView />
          {fixed ? <p className="muted small">The {cavity} follows the pre-op scan: switch to the library tooth to move it.</p> : <NudgePad />}
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
  const fixed = useFollowsPreop();
  if (!bridge) return null;
  const units = bridge.teeth.map((f) => doc.teeth.find((t) => t.fdi === f));
  const placed = units.some((t) => t?.crown);
  const kind = unitKind(doc.setup, activeFdi) === 'pontic' ? 'pontic' : 'crown';

  return (
    <div className="step-body">
      <p className="muted">
        Every unit is placed along the common axis and joined by connectors. Click a unit to adjust it.
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
          <OuterSourceSwitch />
          {isWing(doc.setup, activeFdi) ? (
            <p className="muted small">The wing follows its outline: change the outline or its thickness.</p>
          ) : fixed ? (
            <p className="muted small">{activeFdi} follows the pre-op scan: switch to the library tooth to move it.</p>
          ) : (
            <NudgePad label={`Adjust ${activeFdi}, ${kind}`} />
          )}
          <ScrewChannelPanel />
          <CrownView what="bridge" />
        </>
      )}
    </div>
  );
}
