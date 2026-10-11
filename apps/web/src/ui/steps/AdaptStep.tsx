import { useEffect, useState } from 'react';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { crownTool } from '../../tools/crownTool';
import { useToolStore } from '../../tools/toolStore';
import type { AdaptReportView } from '../../workers/analysisTypes';
import { CrownStatusView } from './CrownStatusView';

const SIDES = [
  { key: 'occlusion', label: 'Occlusion', what: 'antagonist' },
  { key: 'mesial', label: 'Mesial contact', what: 'mesial neighbour' },
  { key: 'distal', label: 'Distal contact', what: 'distal neighbour' },
] as const;

function Report({ report }: { report?: AdaptReportView }) {
  if (!report) return null;
  return (
    <>
      <span className="muted small">
        min {report.minClearanceMm.toFixed(2)} mm · {report.movedVertices} vertices moved (≤ {report.maxMoveMm.toFixed(2)} mm)
      </span>
      {report.conflict && (
        <div className="warning">
          {report.conflict.kind === 'insufficient reduction'
            ? `Insufficient reduction: ${report.conflict.vertices} vertices stay at ${report.conflict.minClearanceMm.toFixed(2)} mm because the crown cannot get thinner (red marker). Reduce the prep or lower the target.`
            : `Contact too tight: ${report.conflict.vertices} vertices stay at ${report.conflict.minClearanceMm.toFixed(2)} mm (red marker).`}
        </div>
      )}
    </>
  );
}

export function AdaptStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const reports = useToolStore((s) => s.crown?.adapt);
  const computing = useToolStore((s) => s.crown?.computing ?? false);
  const crown = tooth?.crown?.kind === 'template' ? tooth.crown : undefined;
  const [targets, setTargets] = useState({
    occlusion: crown?.adapt?.occlusion?.clearanceMm ?? tooth?.params.occlusalClearanceMm ?? 0.05,
    mesial: crown?.adapt?.mesial?.targetMm ?? tooth?.params.proximalContactMm ?? 0.02,
    distal: crown?.adapt?.distal?.targetMm ?? tooth?.params.proximalContactMm ?? 0.02,
  });

  // Show the occlusion map by default here: it is what adaptation changes.
  useEffect(() => {
    if (useToolStore.getState().crownMap === 'none') crownTool.setMap('occlusion');
  }, []);

  if (!tooth) return null;
  if (!crown) return <div className="step-body warning">Propose a crown first.</div>;
  const frame = tooth.frame;
  const dispatch = useDesignStore.getState().dispatch;

  const adapt = (key: (typeof SIDES)[number]['key']) => {
    const value = targets[key];
    if (key === 'occlusion') dispatch({ type: 'adaptOcclusion', fdi: tooth.fdi, clearanceMm: value });
    else dispatch({ type: 'setContact', fdi: tooth.fdi, side: key, targetMm: value });
  };

  return (
    <div className="step-body">
      <p className="muted">
        Moves the occlusal surface and the proximal walls until the clearance to the antagonist and the neighbours reaches
        the target. Negative targets make intentional contact. The minimum thickness always wins; conflicts are reported.
      </p>
      {SIDES.map(({ key, label, what }) => {
        const active = key === 'occlusion' ? crown.adapt?.occlusion : crown.adapt?.[key];
        const noNeighbour = key !== 'occlusion' && !(key === 'mesial' ? frame?.mesialContact : frame?.distalContact);
        return (
          <div className="adapt-row" key={key}>
            <label className="param-field" title={`Target clearance to the ${what} (mm)`}>
              <span>
                {label}
                {active && <span className="badge">on</span>}
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
            </button>
            <Report report={reports?.[key]} />
          </div>
        );
      })}
      <div className="row">
        <button
          className="btn ghost"
          disabled={!crown.adapt}
          onClick={() => {
            const { adapt: _adapt, ...bare } = crown;
            dispatch({ type: 'setCrown', fdi: tooth.fdi, crown: bare });
          }}
        >
          Reset adaptation
        </button>
      </div>
      <CrownStatusView />
    </div>
  );
}
