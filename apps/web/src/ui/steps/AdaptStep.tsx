import type { Command } from '@dcad/shared';
import { useEffect, useState } from 'react';
import { adaptationStale } from '../../design/adaptation';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { crownTool } from '../../tools/crownTool';
import { userEdit } from '../../tools/nudge';
import { useToolStore } from '../../tools/toolStore';
import type { AdaptReportView } from '../../workers/analysisTypes';
import { BridgeConnectors, BridgeResultPanel, connectedTo, useActiveBridge } from './BridgePanels';
import { CrownStatusView } from './CrownStatusView';
import { FocusControls, MapSelect, ReadaptNotice } from './CrownViewControls';
import './NudgePad.css';

const SIDES = [
  { key: 'occlusion', label: 'Occlusion', what: 'antagonist' },
  { key: 'mesial', label: 'Mesial contact', what: 'mesial neighbour' },
  { key: 'distal', label: 'Distal contact', what: 'distal neighbour' },
] as const;

function Report({ report, label, what }: { report?: AdaptReportView; label: string; what: string }) {
  if (!report) return null;
  const open = report.open;
  return (
    <>
      <span className="muted small">
        Closest {report.minClearanceMm.toFixed(2)} mm · surface moved up to {report.maxMoveMm.toFixed(2)} mm
      </span>
      {report.conflict && (
        <div className="warning">
          {report.conflict.kind === 'insufficient reduction'
            ? `Insufficient reduction: ${report.conflict.vertices} vertices stay at ${report.conflict.minClearanceMm.toFixed(2)} mm because the crown cannot get thinner (red marker). Reduce the prep or lower the target.`
            : `Contact too tight: ${report.conflict.vertices} vertices stay at ${report.conflict.minClearanceMm.toFixed(2)} mm (red marker).`}
        </div>
      )}
      {open && (
        <div className="warning">
          {label} open: {Number.isFinite(open.clearanceMm) ? `${open.clearanceMm.toFixed(2)} mm` : `no ${what} within reach`}
          {report.targetMm !== undefined && ` (target ${report.targetMm} mm)`}. Adaptation only closes gaps up to 0.5 mm; move
          the crown toward the {what} and re-adapt.
        </div>
      )}
    </>
  );
}

export function AdaptStep() {
  const activeFdi = useDesignStore((s) => s.activeFdi);
  // Show the occlusion map by default here: it is what adaptation changes.
  useEffect(() => {
    if (useToolStore.getState().crownMap === 'none') crownTool.setMap('occlusion');
  }, []);
  // One panel per tooth, so the targets start from that tooth's own values (bridge units are switched here).
  return <AdaptPanel key={activeFdi} />;
}

function AdaptPanel() {
  const tooth = useDesignStore(selectActiveTooth);
  const doc = useDesignStore((s) => s.doc);
  const bridge = useActiveBridge();
  const reports = useToolStore((s) => s.crown?.adapt);
  const computing = useToolStore((s) => s.crown?.computing ?? false);
  const crown = tooth?.crown?.kind === 'template' ? tooth.crown : undefined;
  const [targets, setTargets] = useState({
    occlusion: crown?.adapt?.occlusion?.clearanceMm ?? tooth?.params.occlusalClearanceMm ?? 0.05,
    mesial: crown?.adapt?.mesial?.targetMm ?? tooth?.params.proximalContactMm ?? 0.02,
    distal: crown?.adapt?.distal?.targetMm ?? tooth?.params.proximalContactMm ?? 0.02,
  });

  if (!tooth) return null;
  if (!crown) return <div className="step-body warning">{bridge ? 'Propose the bridge first.' : 'Propose a crown first.'}</div>;
  const frame = tooth.frame;
  const stale = adaptationStale(tooth);
  // A bridge adapts the occlusion of every unit at once; contacts exist only on free sides.
  const units = bridge ? doc.teeth.filter((t) => bridge.teeth.includes(t.fdi) && t.crown?.kind === 'template') : [];

  const adapt = (key: (typeof SIDES)[number]['key']) => {
    const value = targets[key];
    if (key === 'occlusion' && units.length > 1) userEdit(units.map((t): Command => ({ type: 'adaptOcclusion', fdi: t.fdi, clearanceMm: value })));
    else if (key === 'occlusion') userEdit({ type: 'adaptOcclusion', fdi: tooth.fdi, clearanceMm: value });
    else userEdit({ type: 'setContact', fdi: tooth.fdi, side: key, targetMm: value });
  };

  return (
    <div className="step-body">
      <p className="muted">
        Moves the occlusal surface and the proximal walls until the clearance to the antagonist and the neighbours reaches
        the target. Negative targets make intentional contact. The minimum thickness always wins; conflicts are reported.
        {bridge && ' Sides joined to another unit have a connector instead of a contact.'}
      </p>
      {bridge && <BridgeResultPanel />}
      <ReadaptNotice />
      {SIDES.map(({ key, label, what }) => {
        const joined = bridge && key !== 'occlusion' ? connectedTo(bridge, tooth.fdi, key) : null;
        if (joined) {
          return (
            <div className="adapt-row" key={key}>
              <span>
                {label.replace(' contact', '')} side of {tooth.fdi}: connector to {joined}, no contact
              </span>
            </div>
          );
        }
        const active = key === 'occlusion' ? crown.adapt?.occlusion : crown.adapt?.[key];
        const noNeighbour = key !== 'occlusion' && !(key === 'mesial' ? frame?.mesialContact : frame?.distalContact);
        const all = key === 'occlusion' && units.length > 1;
        return (
          <div className="adapt-row" key={key}>
            <label className="param-field" title={`Target clearance to the ${what} (mm)`}>
              <span>
                {label}
                {active && <span className={`badge${stale ? ' stale' : ''}`}>{stale ? 'off' : 'on'}</span>}
              </span>
              <input
                type="number"
                step={0.01}
                min={-0.2}
                max={key === 'occlusion' ? 1 : 0.5}
                value={targets[key]}
                aria-label={`${label} target (mm)`}
                onChange={(e) => setTargets({ ...targets, [key]: Number(e.target.value) })}
              />
            </label>
            <button className="btn" disabled={computing || noNeighbour} onClick={() => adapt(key)} title={noNeighbour ? `No ${what} found in the tooth frame` : undefined}>
              Adapt {label.toLowerCase()}
              {all ? `, all ${units.length} units` : ''}
            </button>
            <Report report={reports?.[key]} label={label} what={what} />
          </div>
        );
      })}
      <div className="row">
        <button
          className="btn ghost"
          disabled={!crown.adapt}
          onClick={() => {
            const { adapt: _adapt, ...bare } = crown;
            userEdit({ type: 'setCrown', fdi: tooth.fdi, crown: bare });
          }}
        >
          Reset adaptation{bridge ? ` of ${tooth.fdi}` : ''}
        </button>
      </div>
      <CrownStatusView />
      {bridge && <BridgeConnectors />}
      <fieldset className="view-controls">
        <legend>View</legend>
        <MapSelect />
        <FocusControls />
      </fieldset>
    </div>
  );
}
