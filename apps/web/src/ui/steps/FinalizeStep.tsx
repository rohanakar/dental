import { unitKind } from '@dcad/shared';
import { useEffect, useState } from 'react';
import { useDraftOpen } from '../ai/AutoDesign';
import { useIsExported } from '../../state/exported';
import { backToCases, signUpFromOffline, startOwnCase, useSessionStore } from '../../state/session';
import { adaptationStale } from '../../design/adaptation';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { axisTool } from '../../tools/axisTool';
import { crownTool } from '../../tools/crownTool';
import { useToolStore, type AxisReport } from '../../tools/toolStore';
import { AlertIcon, CheckIcon, FailIcon, UnknownIcon } from '../icons';
import { BridgeFinalize, useActiveBridge } from './BridgePanels';
import { CrownStatusView } from './CrownStatusView';
import { MapSelect, ReadaptNotice } from './CrownViewControls';
import { ExportAll } from './ExportAll';
import { FrameworkFinalize } from './FrameworkPanels';
import { isReady, millReadiness, type ReadinessItem, type ReadinessStatus, readinessNeeds } from './readiness';
import { IMPLANT_NEEDS, implantReadiness } from './implantReadiness';
import { useIsImplant } from './ImplantPanel';
import { useImplantStore } from '../../tools/implantTool';
import { MATERIAL_LABEL } from './SetupStep';
import { withInlayRows } from './InlayPanel';
import './NudgePad.css';

const STATUS_ICON = { pass: CheckIcon, fail: FailIcon, unknown: UnknownIcon } satisfies Record<ReadinessStatus, unknown>;
const STATUS_TEXT: Record<ReadinessStatus, string> = { pass: 'passed', fail: 'failed', unknown: 'not measured' };

/** The clinical checks behind "ready to mill", each with its measured value. */
function ReadinessList({ items }: { items: ReadinessItem[] }) {
  const open = items.filter((i) => i.status !== 'pass').length;
  return (
    <section className="readiness" aria-labelledby="readiness-head">
      <div id="readiness-head" className={`readiness-head ${open === 0 ? 'ready' : 'not-ready'}`}>
        {open === 0 ? <CheckIcon /> : <AlertIcon />}
        {open === 0 ? 'Ready to mill' : `Not ready to mill: ${open} ${open === 1 ? 'check' : 'checks'} open`}
      </div>
      <ul>
        {items.map((item) => {
          const Icon = STATUS_ICON[item.status];
          return (
            <li key={item.id} className={item.status}>
              <Icon />
              <span>
                {item.label}
                <span className="visually-hidden">: {STATUS_TEXT[item.status]}</span>
              </span>
              <span className="detail">{item.detail}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
          <button className="btn" onClick={backToCases}>
            Back to cases
          </button>
        )}
      </div>
    </section>
  );
}

function CrownFinalize() {
  const tooth = useDesignStore(selectActiveTooth);
  const material = useDesignStore((s) => s.doc.setup.teeth.find((t) => t.fdi === s.activeFdi)?.material);
  const setup = useDesignStore((s) => s.doc.setup);
  const kind = useDesignStore((s) => unitKind(s.doc.setup, s.activeFdi));
  const crown = useToolStore((s) => s.crown);
  const [axis, setAxis] = useState<AxisReport | null>(null);
  const [measuring, setMeasuring] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [exported, setExported] = useState<{ file: string; at: string } | null>(null);
  const implant = useIsImplant();
  const implantView = useImplantStore((s) => s.result);

  // The axis map is cleared when its step is left, so measure the current axis here.
  const axisInput = tooth?.axis;
  const marginInput = tooth?.margin;
  useEffect(() => {
    let live = true;
    setAxis(null);
    setMeasuring(true);
    void axisTool.measure().then((report) => {
      if (!live) return;
      setAxis(report);
      setMeasuring(false);
    });
    return () => {
      live = false;
    };
  }, [axisInput, marginInput]);

  if (!tooth) return null;
  if (!tooth.crown) return <div className="step-body warning">Propose a crown first.</div>;
  const computed = Boolean(crown && !crown.computing && crown.validation);
  const rows = millReadiness({
    margin: tooth.margin?.points.map((m) => [m.p[0]!, m.p[1]!, m.p[2]!] as const),
    axis,
    crown,
    params: tooth.params,
    material: material ? MATERIAL_LABEL[material] : 'Material',
    adaptationStale: adaptationStale(tooth),
    neighbours: { mesial: Boolean(tooth.frame?.mesialContact), distal: Boolean(tooth.frame?.distalContact) },
    needs: implant ? IMPLANT_NEEDS : readinessNeeds(kind),
  }).concat(implant ? implantReadiness(tooth, implantView, crown?.computing) : []);
  // An inlay or onlay: the inlay gate's rows instead of the adaptation rows.
  const checks = withInlayRows(setup, tooth.fdi, rows, crown?.computing ? undefined : crown?.inlay);
  const items = measuring ? checks.map((i) => (i.id === 'axis' ? { ...i, detail: 'Measuring…' } : i)) : checks;
  const ready = isReady(items);
  const open = items.filter((i) => i.status !== 'pass');

  const exportStl = () => {
    const file = crownTool.export('stl');
    setConfirming(false);
    if (file) setExported({ file, at: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });
  };

  return (
    <div className="step-body">
      <ReadinessList items={items} />
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
          <button className={`btn${ready ? ' primary' : ''}`} disabled={!computed} onClick={ready ? exportStl : () => setConfirming(true)}>
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
