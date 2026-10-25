import { useEffect, useState } from 'react';
import { adaptationStale } from '../../design/adaptation';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { axisTool } from '../../tools/axisTool';
import { crownTool } from '../../tools/crownTool';
import { useToolStore, type AxisReport } from '../../tools/toolStore';
import { AlertIcon, CheckIcon, FailIcon, UnknownIcon } from '../icons';
import { CrownStatusView } from './CrownStatusView';
import { MapSelect, ReadaptNotice } from './CrownViewControls';
import { isReady, millReadiness, type ReadinessItem, type ReadinessStatus } from './readiness';
import { MATERIAL_LABEL } from './SetupStep';
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
  const tooth = useDesignStore(selectActiveTooth);
  const material = useDesignStore((s) => s.doc.setup.teeth.find((t) => t.fdi === s.activeFdi)?.material);
  const crown = useToolStore((s) => s.crown);
  const [axis, setAxis] = useState<AxisReport | null>(null);
  const [measuring, setMeasuring] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [exported, setExported] = useState<{ file: string; at: string } | null>(null);

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
  const checks = millReadiness({
    margin: tooth.margin?.points.map((m) => [m.p[0]!, m.p[1]!, m.p[2]!] as const),
    axis,
    crown,
    params: tooth.params,
    material: material ? MATERIAL_LABEL[material] : 'Material',
    adaptationStale: adaptationStale(tooth),
    neighbours: { mesial: Boolean(tooth.frame?.mesialContact), distal: Boolean(tooth.frame?.distalContact) },
  });
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
      <MapSelect />
      <CrownStatusView detailed />
    </div>
  );
}
