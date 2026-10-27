import { useState } from 'react';
import { useDraftOpen } from '../ai/AutoDesign';
import { useIsExported } from '../../state/exported';
import { backToCases, signUpFromOffline, startOwnCase, useSessionStore } from '../../state/session';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { crownTool } from '../../tools/crownTool';
import { CheckIcon } from '../icons';
import { NeedsFirst } from '../StepFooter';
import { BridgeFinalize, useActiveBridge } from './BridgePanels';
import { CrownStatusView } from './CrownStatusView';
import { MapSelect, ReadaptNotice } from './CrownViewControls';
import { ExportAll } from './ExportAll';
import { FrameworkFinalize } from './FrameworkPanels';
import { isReady } from './readiness';
import { ReadinessList, useCrownReadiness } from './ReadinessList';
import './NudgePad.css';

export function FinalizeStep() {
  const bridge = useActiveBridge();
  const draftOpen = useDraftOpen();
  // Nothing is ready to mill while an auto-design draft is undecided: its review is in the footer.
  if (draftOpen) return <div className="step-body warning">Accept or reject the auto-design draft first.</div>;
  // A bridge is finalized and exported as one piece.
  return (
    <>
      <JourneyEnd />
      {bridge ? <BridgeFinalize /> : <CrownFinalize />}
    </>
  );
}

/** After an export: where to go next. Offline nothing is kept, so say so and offer an account. */
function JourneyEnd() {
  const fdi = useDesignStore((s) => s.activeFdi);
  const exported = useIsExported(fdi);
  const user = useSessionStore((s) => s.user);
  const offline = useSessionStore((s) => s.offline);
  if (!exported) return null;
  return (
    <section className="journey-end" aria-label="What next">
      <p>{offline && !user ? 'Exported. Nothing is saved offline: create an account to keep your cases.' : 'Exported. Start the next case from your case list.'}</p>
      <div className="row wrap">
        {offline && !user ? (
          <>
            <button className="btn primary" onClick={signUpFromOffline}>
              Create an account
            </button>
            <button className="btn" onClick={startOwnCase}>
              Start your own case
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={backToCases}>
            Back to cases
          </button>
        )}
      </div>
    </section>
  );
}

function CrownFinalize() {
  const tooth = useDesignStore(selectActiveTooth);
  const readiness = useCrownReadiness();
  const [confirming, setConfirming] = useState(false);
  const [exported, setExported] = useState<{ file: string; at: string } | null>(null);
  // After an export the ending's own action (JourneyEnd, shown on the same condition) is the primary.
  const done = useIsExported(useDesignStore((s) => s.activeFdi));

  if (!tooth) return null;
  if (!tooth.crown || !readiness) return <NeedsFirst>Propose a crown first.</NeedsFirst>;
  const { items, computed } = readiness;
  const ready = isReady(items);
  const open = items.filter((i) => i.status !== 'pass');

  const exportStl = () => {
    const file = crownTool.export('stl');
    setConfirming(false);
    if (file) setExported({ file, at: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });
  };

  return (
    <div className="step-body">
      <ReadinessList
        items={items}
        note={tooth.margin?.line === 'gum' ? 'This tooth is natural (its margin is the gum line): a crown needs the tooth prepared first, so it cannot be milled as it is.' : undefined}
      />
      {/* Exported as shown: re-adapt first if a later edit switched the adaptation off. */}
      <ReadaptNotice />
      {confirming ? (
        <div className="confirm-box" role="alert">
          <strong>
            Export with {open.length} open {open.length === 1 ? 'check' : 'checks'}?
          </strong>
          <ul>
            {open.map((i) => (
              <li key={i.id}>
                {i.label}: {i.detail}
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="btn primary" onClick={exportStl}>
              Export STL anyway
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className={`btn${ready && !done ? ' primary' : ''}`} disabled={!computed} onClick={ready ? exportStl : () => setConfirming(true)}>
            {ready ? 'Export STL' : 'Export STL anyway…'}
          </button>
          <button className="btn" disabled={!computed} onClick={() => crownTool.export('info')}>
            Construction info
          </button>
        </div>
      )}
      {exported && (
        <div className="export-done" role="status">
          <CheckIcon /> Exported {exported.file} at {exported.at}
        </div>
      )}
      <p className="muted">
        Binary STL in millimetres. Construction info is a JSON file with the margin, axis, parameters, template pose and checks.
      </p>
      <FrameworkFinalize teeth={[tooth.fdi]} />
      <ExportAll />
      <MapSelect />
      <CrownStatusView detailed />
    </div>
  );
}
