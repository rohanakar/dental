import { jawOf } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { useSceneStore } from '../../state/sceneStore';
import { FRAME_COLORS } from '../../tools/controller';
import { clearContact, flipMesialDistal } from '../../tools/frameTool';
import { useToolStore } from '../../tools/toolStore';
import { AutoDesign } from '../ai/AutoDesign';

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

export function FrameStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const fdi = useDesignStore((s) => s.activeFdi);
  const ready = useSceneStore((s) => s.objects.some((o) => o.role === jawOf(fdi) && o.phase === 'ready'));
  const framePick = useToolStore((s) => s.framePick);
  const warnings = useToolStore((s) => s.frameWarnings);
  const autoArmed = useToolStore((s) => s.autoArmed);
  const set = useToolStore((s) => s.set);
  const frame = tooth?.frame;

  if (!tooth) return null;
  if (!ready) return <div className="step-body warning">Load the {jawOf(fdi)} scan first.</div>;

  const pickHint =
    framePick === 'seed'
      ? autoArmed
        ? `One-click crown: click the top of the prepared tooth ${tooth.fdi}. Frame, margin, axis, crown and adaptation are proposed for review.`
        : `Click the top of the prepared tooth ${tooth.fdi}.`
      : `Click the ${framePick === 'mesialContact' ? 'mesial' : 'distal'} neighbour where it should touch the crown.`;

  return (
    <div className="step-body">
      <p className="hint-box">{pickHint}</p>
      <label className="row">
        <input type="checkbox" checked={autoArmed} onChange={(e) => set({ autoArmed: e.target.checked, framePick: 'seed' })} />
        One-click crown (auto-design after the click)
      </label>
      {frame && <AutoDesign compact />}
      {frame ? (
        <>
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
          <div className="muted">Source: {frame.source === 'auto' ? 'automatic' : 'edited'}</div>
          <div className="row">
            <button className="btn" onClick={flipMesialDistal} title="Swap mesial and distal (also flips buccal and lingual)">
              Flip mesial ↔ distal
            </button>
          </div>
          {(['mesial', 'distal'] as const).map((side) => {
            const contact = side === 'mesial' ? frame.mesialContact : frame.distalContact;
            const pick = side === 'mesial' ? 'mesialContact' : 'distalContact';
            return (
              <div className="contact-row" key={side}>
                <span className="swatch" style={{ background: side === 'mesial' ? FRAME_COLORS.mesial : FRAME_COLORS.distal }} />
                <span>
                  {side === 'mesial' ? 'Mesial' : 'Distal'} contact:{' '}
                  {contact ? `${dist(contact, frame.origin).toFixed(1)} mm from the prep` : <em>none</em>}
                </span>
                <button className={`btn${framePick === pick ? ' active' : ''}`} onClick={() => set({ framePick: framePick === pick ? 'seed' : pick })}>
                  {framePick === pick ? 'Cancel' : 'Pick'}
                </button>
                {contact && (
                  <button className="btn ghost" title="No neighbour on this side" onClick={() => clearContact(side)}>
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </>
      ) : (
        <p className="muted">The frame sets the tooth's occlusal, mesial and buccal directions and finds the neighbour contacts.</p>
      )}
      {warnings.map((w) => (
        <div className="warning" key={w}>
          {w}
        </div>
      ))}
    </div>
  );
}
