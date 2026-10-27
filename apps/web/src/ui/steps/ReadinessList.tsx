import { unitKind } from '@dcad/shared';
import { useEffect, useState } from 'react';
import { adaptationStale } from '../../design/adaptation';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { axisTool } from '../../tools/axisTool';
import { useImplantStore } from '../../tools/implantTool';
import { useToolStore, type AxisReport } from '../../tools/toolStore';
import { AlertIcon, CheckIcon, FailIcon, UnknownIcon } from '../icons';
import { useIsImplant } from './ImplantPanel';
import { IMPLANT_NEEDS, implantReadiness } from './implantReadiness';
import { withInlayRows } from './InlayPanel';
import { millReadiness, type ReadinessItem, type ReadinessStatus, readinessNeeds } from './readiness';
import { MATERIAL_LABEL } from './SetupStep';

const STATUS_ICON = { pass: CheckIcon, fail: FailIcon, unknown: UnknownIcon } satisfies Record<ReadinessStatus, unknown>;
const STATUS_TEXT: Record<ReadinessStatus, string> = { pass: 'passed', fail: 'failed', unknown: 'not measured' };

/** Rows measured on the crown: stale while it recomputes. */
const CROWN_ROWS = new Set(['solid', 'thickness', 'occlusion', 'mesial', 'distal']);

/**
 * The clinical checks behind "ready to mill", each with its measured value. `compact` (the draft review): no head, the
 * review's verdict is the head, and each row runs on as one line of small type. `note` says up front why the design is
 * not ready, when that is plain (a natural tooth).
 */
export function ReadinessList({ items, compact = false, note }: { items: ReadinessItem[]; compact?: boolean; note?: string }) {
  const open = items.filter((i) => i.status !== 'pass').length;
  const rows = (
    <ul>
      {items.map((item) => {
        const Icon = STATUS_ICON[item.status];
        return (
          <li key={item.id} className={item.status}>
            <Icon />
            <span>
              {item.label}
              <span className="visually-hidden">: {STATUS_TEXT[item.status]}</span>
              {compact && <span className="detail"> {item.detail}</span>}
            </span>
            {!compact && <span className="detail">{item.detail}</span>}
          </li>
        );
      })}
    </ul>
  );
  if (compact) {
    return (
      <section className="readiness compact" aria-label="Ready to mill">
        {rows}
      </section>
    );
  }
  return (
    <section className="readiness" aria-labelledby="readiness-head">
      <div id="readiness-head" className={`readiness-head ${open === 0 ? 'ready' : 'not-ready'}`}>
        {open === 0 ? <CheckIcon /> : <AlertIcon />}
        {open === 0 ? 'Ready to mill' : `Not ready to mill: ${open} ${open === 1 ? 'check' : 'checks'} open`}
      </div>
      {note && open > 0 && <p className="readiness-note">{note}</p>}
      {rows}
    </section>
  );
}

/**
 * The active tooth's ready-to-mill rows (Finalize, and the draft review on the draft): the crown, implant and inlay
 * rows, with the axis measured here. A row being measured (the axis, or the crown while it recomputes) reads
 * "Measuring…". Null without a tooth or a crown; `computed` once the crown has a result.
 */
export function useCrownReadiness(): { items: ReadinessItem[]; computed: boolean } | null {
  const tooth = useDesignStore(selectActiveTooth);
  const material = useDesignStore((s) => s.doc.setup.teeth.find((t) => t.fdi === s.activeFdi)?.material);
  const setup = useDesignStore((s) => s.doc.setup);
  const kind = useDesignStore((s) => unitKind(s.doc.setup, s.activeFdi));
  const crown = useToolStore((s) => s.crown);
  const implant = useIsImplant();
  const implantView = useImplantStore((s) => s.result);
  const [axis, setAxis] = useState<AxisReport | null>(null);
  const [measuring, setMeasuring] = useState(true);

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

  if (!tooth?.crown) return null;
  const computing = Boolean(crown?.computing);
  const rows = millReadiness({
    margin: tooth.margin?.points.map((m) => [m.p[0]!, m.p[1]!, m.p[2]!] as const),
    axis,
    crown,
    params: tooth.params,
    material: material ? MATERIAL_LABEL[material] : 'Material',
    adaptationStale: adaptationStale(tooth),
    neighbours: { mesial: Boolean(tooth.frame?.mesialContact), distal: Boolean(tooth.frame?.distalContact) },
    needs: implant ? IMPLANT_NEEDS : readinessNeeds(kind),
    ...(tooth.margin?.line ? { marginLine: tooth.margin.line } : {}),
  }).concat(implant ? implantReadiness(tooth, implantView, computing) : []);
  // An inlay or onlay: the inlay gate's rows instead of the adaptation rows.
  const checks = withInlayRows(setup, tooth.fdi, rows, computing ? undefined : crown?.inlay);
  const items = checks.map((i): ReadinessItem => ((i.id === 'axis' && measuring) || (CROWN_ROWS.has(i.id) && computing) ? { ...i, status: 'unknown', detail: 'Measuring…' } : i));
  return { items, computed: Boolean(crown && !computing && crown.validation) };
}
