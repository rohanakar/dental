import { jawOf, unitKind } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { useSceneStore } from '../../state/sceneStore';
import { FRAME_COLORS } from '../../tools/controller';
import { clearContact, flipMesialDistal } from '../../tools/frameTool';
import { demoPrep } from '../../tools/demoPrep';
import { useToolStore } from '../../tools/toolStore';
import { AutoDesign } from '../ai/AutoDesign';
import { CloseIcon } from '../icons';
import { NeedsFirst } from '../StepFooter';
import { BridgeFramePanel, connectedTo, useActiveBridge } from './BridgePanels';

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

const FrameAxes = () => (
  <ul className="axis-legend">
    <li>
      <span className="swatch" style={{ background: FRAME_COLORS.occlusal }} /> Occlusal
    </li>
    <li>
      <span className="swatch" style={{ background: FRAME_COLORS.mesial }} /> Mesial
    </li>
    <li>
      <span className="swatch" style={{ background: FRAME_COLORS.buccal }} /> Buccal
    </li>
  </ul>
);

export function FrameStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const fdi = useDesignStore((s) => s.activeFdi);
  const pontic = useDesignStore((s) => unitKind(s.doc.setup, s.activeFdi) === 'pontic');
  const bridge = useActiveBridge();
  const ready = useSceneStore((s) => s.objects.some((o) => o.role === jawOf(fdi) && o.phase === 'ready'));
  const framePick = useToolStore((s) => s.framePick);
  const warnings = useToolStore((s) => s.frameWarnings);
  const autoArmed = useToolStore((s) => s.autoArmed);
  const set = useToolStore((s) => s.set);
  const frame = tooth?.frame;

  if (!tooth) return null;
  if (!ready) return <NeedsFirst>Load the {jawOf(fdi)} scan first.</NeedsFirst>;

  // A pontic has no prep to click: its frame comes from the arch between the abutments, or a click on the ridge.
  if (pontic && bridge) {
    return (
      <div className="step-body">
        <p className="hint-box">
          {frame
            ? `Pontic ${tooth.fdi} is placed${frame.source === 'manual' ? ' where you clicked' : ' on the arch'}. Click the ridge to move its centre.`
            : `Pontic ${tooth.fdi} needs no prep click: place the pontics below, or click the ridge where its centre should be.`}
        </p>
        {frame && <FrameAxes />}
        <BridgeFramePanel />
      </div>
    );
  }

  // The demo knows its prep (a blue ring marks it); a real case only knows the tooth number.
  const demo = !frame && demoPrep() !== null;
  const target = demo ? 'the prepared tooth inside the blue ring' : `the top of the prepared tooth ${tooth.fdi}`;
  // With a frame (set from its prep on entering the step, or by a click) the step is a review.
  const pickHint =
    framePick === 'seed'
      ? frame
        ? bridge
          ? `Frame set on ${tooth.fdi}. Check the arrows, or click the prep again to redo it.`
          : `Frame set on ${tooth.fdi}. Check the arrows, then auto-design the crown, or click the prep again to redo the frame.`
        : autoArmed
          ? bridge
            ? `Click ${target}. After the last abutment, auto-design proposes the bridge for you to review.`
            : `Click ${target}. Auto-design proposes the crown for you to review.`
          : `Click ${target}.`
      : `Click the ${framePick === 'mesialContact' ? 'mesial' : 'distal'} neighbour where it should touch the crown.`;

  return (
    <div className="step-body">
      <p className="hint-box">{pickHint}</p>
      <label className="row">
        <input type="checkbox" checked={autoArmed} onChange={(e) => set({ autoArmed: e.target.checked, framePick: 'seed' })} />
        {bridge ? 'One-click bridge (auto-design after the last abutment click)' : 'One-click crown (auto-design after the click)'}
      </label>
      {/* In a bridge the step's main action is in the bridge panel (place the pontics). */}
      {frame && <AutoDesign compact primary={!bridge} />}
      {frame ? (
        <>
          <FrameAxes />
          <div className="row">
            <button className="btn" onClick={flipMesialDistal} title="Also swaps buccal and lingual">
              Swap mesial and distal
            </button>
          </div>
          {(['mesial', 'distal'] as const).map((side) => {
            const contact = side === 'mesial' ? frame.mesialContact : frame.distalContact;
            const pick = side === 'mesial' ? 'mesialContact' : 'distalContact';
            const joined = bridge && connectedTo(bridge, tooth.fdi, side);
            if (joined) {
              return (
                <div className="contact-row" key={side}>
                  <span className="swatch" style={{ background: side === 'mesial' ? FRAME_COLORS.mesial : FRAME_COLORS.distal }} />
                  <span>
                    {side === 'mesial' ? 'Mesial' : 'Distal'}: connector to {joined}, no contact
                  </span>
                </div>
              );
            }
            return (
              <div className="contact-row" key={side}>
                <span className="swatch" style={{ background: side === 'mesial' ? FRAME_COLORS.mesial : FRAME_COLORS.distal }} />
                <span>
                  {side === 'mesial' ? 'Mesial' : 'Distal'} contact:{' '}
                  {contact ? `${dist(contact, frame.origin).toFixed(1)} mm from the prep` : <em>none</em>}
                </span>
                <button
                  className="btn"
                  aria-pressed={framePick === pick}
                  aria-label={framePick === pick ? `Cancel picking the ${side} contact` : `Pick the ${side} contact in the viewport`}
                  onClick={() => set({ framePick: framePick === pick ? 'seed' : pick })}
                >
                  {framePick === pick ? 'Cancel' : 'Pick'}
                </button>
                {contact && (
                  <button className="btn ghost icon" aria-label={`Remove the ${side} contact (no neighbour on this side)`} title="No neighbour on this side" onClick={() => clearContact(side)}>
                    <CloseIcon />
                  </button>
                )}
              </div>
            );
          })}
        </>
      ) : null}
      {warnings.map((w) => (
        <div className="warning" key={w}>
          {w}
        </div>
      ))}
      {bridge && <BridgeFramePanel />}
    </div>
  );
}
