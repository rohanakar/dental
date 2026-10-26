import {
  bridgeOf,
  type BridgeDesign,
  connectedSides,
  type ConnectorDesign,
  type DesignDocument,
  facingSide,
  type ProximalSide,
  type QaCheck,
  type ToothDesign,
  unitKind,
} from '@dcad/shared';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { bridgeGate } from '../../ai/qa';
import { adaptationStale } from '../../design/adaptation';
import { useDesignStore } from '../../design/store';
import { axisTool } from '../../tools/axisTool';
import { bridgeTool, type BridgeResult, unitStatus, useBridgeStore } from '../../tools/bridgeTool';
import { ALIGN_MIN_DEG, alignAbutments, bridgeFramesRequest, placePontics } from '../../tools/frameTool';
import { userEdit } from '../../tools/nudge';
import type { AxisReport } from '../../tools/toolStore';
import type { BridgeConnectorView, BridgeFramesResult } from '../../workers/analysisTypes';
import { analysis } from '../../workers/geometryClient';
import { isStale } from '../../workers/latestWins';
import { AlertIcon, CheckIcon, FailIcon, UnknownIcon } from '../icons';
import { CrownStatusView } from './CrownStatusView';
import { MapSelect } from './CrownViewControls';
import { isReady, millReadiness, type ReadinessItem, type ReadinessStatus, readinessNeeds } from './readiness';
import { IMPLANT_NEEDS, implantReadiness } from './implantReadiness';
import { isImplantTooth } from '../../tools/implantTool';
import { MATERIAL_LABEL } from './SetupStep';
import '../bridge.css';

/** The active tooth's bridge (stable reference from the document), or undefined for a single crown. */
export const useActiveBridge = (): BridgeDesign | undefined => useDesignStore((s) => bridgeOf(s.doc, s.activeFdi));

const toothOf = (doc: DesignDocument, fdi: number): ToothDesign | undefined => doc.teeth.find((t) => t.fdi === fdi);

/** The unit joined to `fdi` on `side` by a connector, or null (a free side). */
export function connectedTo(bridge: BridgeDesign, fdi: number, side: ProximalSide): number | null {
  for (const { between } of bridge.connectors) {
    if (!between.includes(fdi)) continue;
    const other = between[0] === fdi ? between[1] : between[0];
    if (facingSide(fdi, other) === side) return other;
  }
  return null;
}
const kindLabel = (doc: DesignDocument, fdi: number) => (unitKind(doc.setup, fdi) === 'pontic' ? 'pontic' : 'crown');
/** A length, never printed as "-0.000". */
const mm = (v: number, digits = 2) => `${(Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits)} mm`;
const mm2 = (v: number) => `${v.toFixed(1)} mm²`;

/** Object ids for effect dependencies: one number per object identity. */
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function identityKey(values: readonly unknown[]): string {
  return values
    .map((v) => {
      if (!v || typeof v !== 'object') return String(v);
      let id = objectIds.get(v);
      if (!id) objectIds.set(v, (id = nextObjectId++));
      return `#${id}`;
    })
    .join(',');
}

// ---- unit picker --------------------------------------------------------------------------------

type UnitState = 'done' | 'stale' | 'pending';
const UNIT_STATE_TEXT: Record<UnitState, string> = { done: 'done', stale: 'out of date', pending: 'not done yet' };

/**
 * The units of the active bridge in arch order; one is the active tooth. `stateOf` marks each unit for the step
 * (frame placed, crown placed). Clicking a unit makes it active, like clicking it in the viewport.
 */
export function BridgeUnits({ stateOf, label }: { stateOf?: (tooth: ToothDesign) => UnitState; label: string }) {
  const bridge = useActiveBridge();
  const doc = useDesignStore((s) => s.doc);
  const activeFdi = useDesignStore((s) => s.activeFdi);
  if (!bridge) return null;
  return (
    <div className="bridge-units" role="group" aria-label={label}>
      {bridge.teeth.map((fdi) => {
        const tooth = toothOf(doc, fdi);
        const state = tooth && stateOf ? stateOf(tooth) : null;
        return (
          <button
            key={fdi}
            type="button"
            className={`bridge-unit ${unitKind(doc.setup, fdi)}${state ? ` ${state}` : ''}`}
            aria-pressed={fdi === activeFdi}
            title={`Make ${fdi} the active unit`}
            onClick={() => useDesignStore.getState().setActiveFdi(fdi)}
          >
            <span className="bridge-unit-fdi">{fdi}</span>
            <span className="bridge-unit-kind">{kindLabel(doc, fdi)}</span>
            {state && <span className="visually-hidden">, {UNIT_STATE_TEXT[state]}</span>}
          </button>
        );
      })}
    </div>
  );
}

const frameState = (t: ToothDesign): UnitState => (t.frame ? (t.steps.frame === 'stale' ? 'stale' : 'done') : 'pending');
const crownState = (t: ToothDesign): UnitState => (t.crown ? (t.steps.proposal === 'stale' ? 'stale' : 'done') : 'pending');

// ---- Frame step ---------------------------------------------------------------------------------

/**
 * Bridge part of the Frame step: abutments are clicked as for a single crown; once they all have a frame, their
 * mesial-distal line can be aligned to the arch curve, and the pontics are laid out on the arch between them (or
 * placed by a click on the ridge while a pontic is active).
 */
export function BridgeFramePanel() {
  const bridge = useActiveBridge();
  const doc = useDesignStore((s) => s.doc);
  const activeFdi = useDesignStore((s) => s.activeFdi);
  const [frames, setFrames] = useState<{ result: BridgeFramesResult | null; error: string | null; busy: boolean }>({ result: null, error: null, busy: false });

  const abutments = (bridge?.teeth ?? []).filter((f) => unitKind(doc.setup, f) === 'abutment');
  const pontics = (bridge?.teeth ?? []).filter((f) => unitKind(doc.setup, f) === 'pontic');
  const unframed = abutments.filter((f) => !toothOf(doc, f)?.frame);
  // Re-analysed when an abutment frame or margin changes (pontic frames do not change the layout).
  const key = identityKey(abutments.flatMap((f) => [toothOf(doc, f)?.frame, toothOf(doc, f)?.margin]));

  useEffect(() => {
    let live = true;
    const request = bridgeFramesRequest(useDesignStore.getState().doc, activeFdi);
    if (!request) {
      setFrames({ result: null, error: null, busy: false });
      return;
    }
    setFrames((f) => ({ ...f, busy: true }));
    analysis
      .bridgeFrames(request)
      .then((result) => live && setFrames({ result, error: null, busy: false }))
      .catch((e: unknown) => {
        if (live && !isStale(e)) setFrames({ result: null, error: e instanceof Error ? e.message : String(e), busy: false });
      });
    return () => {
      live = false;
    };
    // `key` stands for the abutment frames and margins; the active unit does not change the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bridge]);

  if (!bridge) return null;
  const result = frames.result;
  const changes = result?.abutments ?? [];
  const toAlign = changes.filter((a) => a.changeDeg >= ALIGN_MIN_DEG);
  const placed = pontics.filter((f) => toothOf(doc, f)?.frame);
  const stalePontics = pontics.filter((f) => toothOf(doc, f)?.steps.frame === 'stale');
  // Before the margins exist the abutments' widths are nominal, so the room for the pontics is only an estimate.
  const estimated = abutments.some((f) => !toothOf(doc, f)?.margin);
  const warnings = result ? [...result.curve.warnings, ...(estimated ? [] : result.pontics.flatMap((p) => p.warnings))] : [];

  return (
    <section className="bridge-panel" aria-labelledby="bridge-frame-head">
      <h3 id="bridge-frame-head">
        Bridge {bridge.teeth[0]}–{bridge.teeth.at(-1)}
      </h3>
      <BridgeUnits label="Bridge units: frame" stateOf={frameState} />
      {unframed.length > 0 ? (
        <p className="muted">
          Click the prep of each abutment ({unframed.join(', ')} still {unframed.length === 1 ? 'needs' : 'need'} a frame). The pontics are then laid out
          on the arch between them.
        </p>
      ) : (
        <>
          <div className="bridge-action">
            <div>
              <strong>Align to arch</strong>
              <div className="muted small">The abutments' mesial–distal line from the arch curve; occlusal and origin stay.</div>
              {changes.length > 0 && (
                <ul className="bridge-changes">
                  {changes.map((a) => (
                    <li key={a.fdi}>
                      {a.fdi}: {a.changeDeg < ALIGN_MIN_DEG ? 'aligned' : `turns ${a.changeDeg.toFixed(1)}°`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button className="btn" disabled={!result || toAlign.length === 0} onClick={() => result && alignAbutments(result)}>
              Align to arch
            </button>
          </div>
          {pontics.length > 0 && (
            <div className="bridge-action">
              <div>
                <strong>Pontics</strong>
                <div className="muted small">
                  {placed.length === pontics.length
                    ? stalePontics.length
                      ? `${stalePontics.join(', ')}: an abutment frame changed since; place again.`
                      : `Placed on the arch: ${pontics.join(', ')}. Click the ridge to move the active pontic.`
                    : 'Laid out on the arch between the abutments, sized by the room there.'}
                  {estimated && ' The room is estimated until the margins are drawn.'}
                </div>
              </div>
              <button
                className={`btn${placed.length < pontics.length || stalePontics.length ? ' primary' : ''}`}
                disabled={!result}
                onClick={() => result && placePontics(result)}
              >
                {placed.length ? 'Re-place pontics' : 'Place pontics'}
              </button>
            </div>
          )}
        </>
      )}
      {frames.busy && (
        <div className="row muted" role="status">
          <span className="spinner" /> Fitting the arch curve…
        </div>
      )}
      {frames.error && <div className="error">{frames.error}</div>}
      {warnings.map((w) => (
        <div className="warning" key={w}>
          {w}
        </div>
      ))}
    </section>
  );
}

// ---- Axis step ----------------------------------------------------------------------------------

/** Per-abutment read-out of the common axis: margin in undercut, blockout, and the angle to each one's own best axis. */
export function BridgeAxisReport({ report }: { report: AxisReport }) {
  const bridge = report.bridge;
  if (!bridge) return null;
  return (
    <>
      <table className="bridge-table">
        <caption className="visually-hidden">The common insertion axis on each abutment</caption>
        <thead>
          <tr>
            <th scope="col">Abutment</th>
            <th scope="col">Margin in undercut</th>
            <th scope="col">Blockout</th>
            <th scope="col">From own axis</th>
          </tr>
        </thead>
        <tbody>
          {bridge.abutments.map((a) => (
            <tr key={a.fdi}>
              <th scope="row">{a.fdi}</th>
              <td className={a.marginUndercutCount > 0 ? 'bad' : 'ok'}>
                {a.marginUndercutCount} / {a.marginPointCount}
              </td>
              <td>{mm2(a.blockoutAreaMm2)}</td>
              <td>{a.angleToOwnDeg === null ? '—' : `${a.angleToOwnDeg.toFixed(1)}°`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="params">
        <dt>Divergence of the abutments' own axes</dt>
        <dd>{bridge.divergenceDeg === null ? 'measuring…' : `${bridge.divergenceDeg.toFixed(1)}°`}</dd>
      </dl>
      {bridge.warnings.map((w) => (
        <div className="warning" key={w}>
          {w}
        </div>
      ))}
    </>
  );
}

// ---- Proposal and Adapt: the bridge result ---------------------------------------------------------

/** Units of the displayed bridge with their placement state, and the bridge-level warnings (layout, connectors). */
export function BridgeResultPanel() {
  const result = useBridgeStore((s) => s.result);
  const missing = useBridgeStore((s) => s.missing);
  const error = useBridgeStore((s) => s.error);
  const unitWarnings = new Set(result?.units.flatMap((u) => u.warnings.map((w) => `${u.fdi}: ${w}`)) ?? []);
  // Unit warnings are shown with the active unit's status; the rest belong to the bridge.
  const warnings = [...new Set(result?.warnings ?? [])].filter((w) => !unitWarnings.has(w));
  return (
    <>
      <BridgeUnits label="Bridge units" stateOf={crownState} />
      {missing && <div className="warning">{missing}</div>}
      {error && !missing && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {warnings.map((w) => (
        <div className="warning" key={w}>
          {w}
        </div>
      ))}
    </>
  );
}

// ---- Adapt step: connectors -----------------------------------------------------------------------

/** A number field committed on blur or Enter (one undo entry per edit, not per keystroke). */
function CommitField(props: { label: string; value: number; min: number; max: number; step: number; unit: string; onCommit(value: number): void }) {
  const { label, value, min, max, step, unit, onCommit } = props;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n === value) return setDraft(String(value));
    onCommit(Math.min(max, Math.max(min, n)));
  };
  return (
    <label className="connector-field">
      <span>{label}</span>
      <span className="unit-input">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          aria-label={`${label} (${unit})`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="unit">{unit}</span>
      </span>
    </label>
  );
}

function ConnectorCard({ connector, settings, measured }: { connector?: BridgeConnectorView; settings: ConnectorDesign; measured?: BridgeCheckView }) {
  const [a, b] = settings.between;
  const edit = (patch: Partial<Pick<ConnectorDesign, 'areaMm2' | 'buccalMm' | 'occlusalMm'>>) => userEdit({ type: 'setConnector', between: [a, b], ...patch });
  const failures = [...(connector?.failures.map((f) => f.message) ?? []), ...(measured?.failures ?? [])];
  const failed = failures.length > 0;
  const min = connector?.minAreaMm2 ?? settings.areaMm2;
  const status = failed ? 'failed' : measured ? 'checked' : 'designed';
  return (
    <li className={`connector-card${failed ? ' failed' : ''}`} aria-label={`Connector ${a}–${b}`}>
      <div className="connector-head">
        <strong>
          {a}–{b}
        </strong>
        <span className={`connector-status ${status}`}>
          {failed ? <FailIcon /> : measured ? <CheckIcon /> : <UnknownIcon />}
          {failed ? 'fails' : measured ? 'checked' : 'not checked yet'}
        </span>
      </div>
      {connector && (
        <dl className="params">
          <dt>Designed area</dt>
          <dd>
            {mm2(connector.areaMm2)} <span className="muted">/ min {mm2(connector.minAreaMm2)}</span>
          </dd>
          <dt>Smallest section</dt>
          <dd className={measured ? (measured.failures.length ? 'bad' : 'ok') : undefined}>{measured ? mm2(measured.areaMm2) : <span className="muted">check to measure</span>}</dd>
          <dt>Height</dt>
          <dd className={connector.heightMm < connector.minHeightMm ? 'bad' : undefined}>
            {mm(connector.heightMm, 1)} <span className="muted">/ min {mm(connector.minHeightMm, 1)}, room {mm(connector.available.heightMm, 1)}</span>
          </dd>
          <dt>Width</dt>
          <dd>{mm(connector.widthMm, 1)}</dd>
        </dl>
      )}
      <div className="connector-fields">
        <CommitField label="Area" unit="mm²" value={settings.areaMm2} min={min} max={50} step={0.5} onCommit={(v) => edit({ areaMm2: v })} />
        <CommitField label="Buccal" unit="mm" value={settings.buccalMm} min={-2} max={2} step={0.1} onCommit={(v) => edit({ buccalMm: v })} />
        <CommitField label="Occlusal" unit="mm" value={settings.occlusalMm} min={-2} max={2} step={0.1} onCommit={(v) => edit({ occlusalMm: v })} />
      </div>
      {failures.map((f) => (
        <div className="error" key={f}>
          {f}
        </div>
      ))}
    </li>
  );
}

interface BridgeCheckView {
  areaMm2: number;
  heightMm: number;
  failures: string[];
}

/**
 * Pass or fail of the bridge checks whose id starts with `prefix`: the same gate as auto-design's (bridgeGate), so the
 * checklist and the AI agree. 'unknown' when the gate has no such check.
 */
function gateStatus(gate: readonly QaCheck[], prefix: string): ReadinessStatus {
  const checks = gate.filter((c) => c.id === prefix || c.id.startsWith(`${prefix}.`));
  return checks.length === 0 ? 'unknown' : checks.every((c) => c.passed) ? 'pass' : 'fail';
}

/** The measured connector (smallest section on the union) from a current check, with what failed in plain words. */
function measuredConnector(check: BridgeResult | null, between: readonly [number, number]): BridgeCheckView | undefined {
  const c = check?.union?.checks.connectors.find((x) => x.between[0] === between[0] && x.between[1] === between[1]);
  if (!c || !check) return undefined;
  const [a, b] = between;
  const gate = bridgeGate(check);
  const failed = (what: string) => gate.some((q) => q.id === `bridge.connector.${a}-${b}.${what}` && !q.passed);
  const failures: string[] = [];
  const areaLimit = Math.max(c.targetAreaMm2, c.minAreaMm2);
  if (failed('area')) failures.push(`Connector ${a}–${b}: smallest section ${c.measured.minAreaMm2.toFixed(2)} mm² is below ${areaLimit} mm².`);
  if (failed('height')) failures.push(`Connector ${a}–${b}: height ${Math.min(c.measured.heightMm, c.designedHeightMm).toFixed(2)} mm is below ${c.minHeightMm} mm.`);
  return { areaMm2: c.measured.minAreaMm2, heightMm: c.measured.heightMm, failures };
}

/** The bridge-level checks of a union check (merged solid, seating, pontic base), as readiness rows. */
function unionRows(check: BridgeResult): ReadinessItem[] {
  if (!check.union) {
    return [{ id: 'union', label: 'One solid', status: 'fail', detail: check.unionError ?? 'The bridge could not be merged' }];
  }
  const gate = bridgeGate(check);
  const { union, seating, ponticBase } = check.union.checks;
  const solid = gateStatus(gate, 'bridge.union');
  const rows: ReadinessItem[] = [
    {
      id: 'union',
      label: 'One solid',
      status: solid,
      detail:
        solid === 'pass'
          ? `Closed, printable, one part (${union.triangles.toLocaleString()} triangles)`
          : !union.printable
            ? `Not a printable closed solid (${union.selfIntersections} self-intersections)`
            : `${union.components} parts, genus ${union.genus}`,
    },
  ];
  for (const s of seating) {
    rows.push({
      id: `seating-${s.fdi}`,
      label: `Seating unchanged on ${s.fdi}`,
      status: gateStatus(gate, `bridge.seating.${s.fdi}`),
      detail: `${(s.deltaMeanMm * 1000).toFixed(1)} µm mean, ${(s.deltaMaxMm * 1000).toFixed(1)} µm max change of the cement gap`,
    });
  }
  for (const p of ponticBase) {
    rows.push({
      id: `base-${p.fdi}`,
      label: `Pontic ${p.fdi} on the ridge`,
      status: gateStatus(gate, `bridge.ponticBase.${p.fdi}`),
      detail: Number.isFinite(p.minGapMm) ? `Gap ${mm(p.minGapMm, 3)} min, target ${mm(p.targetMm)}` : 'Base not over the scanned ridge',
    });
  }
  return rows;
}

const STATUS_ICON = { pass: CheckIcon, fail: FailIcon, unknown: UnknownIcon } satisfies Record<ReadinessStatus, unknown>;
const STATUS_TEXT: Record<ReadinessStatus, string> = { pass: 'passed', fail: 'failed', unknown: 'not measured' };

function Rows({ items }: { items: ReadinessItem[] }) {
  return (
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
  );
}

/** "Check bridge": merge into one solid and measure it (union + checks); the result stays until the design changes. */
export function BridgeCheckButton({ primary = false }: { primary?: boolean }) {
  const check = useBridgeStore((s) => s.check);
  const missing = useBridgeStore((s) => s.missing);
  const result = useBridgeStore((s) => s.result);
  return (
    <div className="row wrap">
      <button className={`btn${primary ? ' primary' : ''}`} disabled={check.running || Boolean(missing) || !result} onClick={() => void bridgeTool.check()}>
        {check.running ? 'Checking…' : check.current ? 'Check again' : 'Check bridge'}
      </button>
      <span className="muted small" role="status">
        {check.running ? (
          <>
            <span className="spinner" /> Merging the units and connectors…
          </>
        ) : check.result && !check.current ? (
          'The design changed since the last check.'
        ) : check.current ? (
          `Checked: ${check.result?.union?.checks.ok ? 'every check passed' : 'some checks fail'}.`
        ) : (
          'Merges the bridge into one solid and measures the connectors on it.'
        )}
      </span>
    </div>
  );
}

/** Adapt step: one panel per connector (designed and measured area, height, offsets) and the bridge check. */
export function BridgeConnectors() {
  const bridge = useActiveBridge();
  const result = useBridgeStore((s) => s.result);
  const check = useBridgeStore((s) => s.check);
  if (!bridge || bridge.connectors.length === 0) return null;
  const checked = check.current ? check.result : null;
  return (
    <section className="bridge-panel" aria-labelledby="connectors-head">
      <h3 id="connectors-head">Connectors</h3>
      <p className="muted small">
        Sides joined to another unit have a connector instead of a contact. The area never goes below the material minimum; the offsets move the
        connector from its automatic position.
      </p>
      <ul className="connector-list">
        {bridge.connectors.map((settings) => {
          const [a, b] = settings.between;
          const connector = result?.connectors.find((c) => c.between[0] === a && c.between[1] === b);
          return <ConnectorCard key={`${a}-${b}`} settings={settings} connector={connector} measured={measuredConnector(checked, settings.between)} />;
        })}
      </ul>
      <BridgeCheckButton />
      {check.error && !check.running && <div className="error">{check.error}</div>}
      {checked && (
        <div className="readiness">
          <Rows items={unionRows(checked)} />
        </div>
      )}
    </section>
  );
}

/** The free proximal sides of a unit with a natural neighbour (contacts are checked only there). */
export function freeNeighbours(doc: DesignDocument, tooth: ToothDesign, frame?: { mesialContact?: unknown; distalContact?: unknown }): Record<ProximalSide, boolean> {
  const connected = connectedSides(doc, tooth.fdi);
  const f = tooth.frame ?? frame;
  return {
    mesial: Boolean(f?.mesialContact) && !connected.includes('mesial'),
    distal: Boolean(f?.distalContact) && !connected.includes('distal'),
  };
}

// ---- Finalize --------------------------------------------------------------------------------------

/**
 * Finalize for a bridge: the ready-to-mill rows per unit (a unit's connected sides are not contacts), then the
 * connectors and the merged solid, all under one soft gate; the export is the merged solid as one STL plus its
 * construction sidecar.
 */
export function BridgeFinalize() {
  const bridge = useActiveBridge();
  const doc = useDesignStore((s) => s.doc);
  const result = useBridgeStore((s) => s.result);
  const computing = useBridgeStore((s) => s.computing);
  const check = useBridgeStore((s) => s.check);
  const missing = useBridgeStore((s) => s.missing);
  const [axes, setAxes] = useState<Record<number, AxisReport | null> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [exported, setExported] = useState<{ file: string; at: string } | null>(null);

  const abutments = (bridge?.teeth ?? []).filter((f) => unitKind(doc.setup, f) === 'abutment');
  const axisKey = identityKey(abutments.flatMap((f) => [toothOf(doc, f)?.axis, toothOf(doc, f)?.margin]));

  // Each abutment's margin against the common axis (the axis map is cleared when its step is left).
  useEffect(() => {
    let live = true;
    setAxes(null);
    void Promise.all(abutments.map(async (f) => [f, await axisTool.measureTooth(f)] as const)).then((rows) => {
      if (live) setAxes(Object.fromEntries(rows));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axisKey]);

  // The union check runs by itself once per displayed design (so after any change), never in a loop on a failure.
  const checkedFor = useRef<BridgeResult | null>(null);
  useEffect(() => {
    if (!result || computing || check.current || check.running || missing || checkedFor.current === result) return;
    checkedFor.current = result;
    void bridgeTool.check();
  }, [result, computing, check.current, check.running, missing]);

  if (!bridge) return null;
  const units = bridge.teeth.map((f) => toothOf(doc, f)).filter((t): t is ToothDesign => Boolean(t));
  if (!units.some((t) => t.crown)) return <div className="step-body warning">Propose the bridge first.</div>;
  const material = doc.setup.teeth.find((t) => t.fdi === bridge.teeth[0])?.material;
  const materialLabel = material ? MATERIAL_LABEL[material] : 'Material';

  const groups = units.map((tooth) => {
    const kind = unitKind(doc.setup, tooth.fdi);
    const view = result?.units.find((u) => u.fdi === tooth.fdi);
    const items = millReadiness({
      margin: tooth.margin?.points.map((m) => [m.p[0]!, m.p[1]!, m.p[2]!] as const),
      axis: axes ? (axes[tooth.fdi] ?? null) : null,
      crown: view && !computing ? unitStatus(view) : null,
      params: tooth.params,
      material: materialLabel,
      adaptationStale: adaptationStale(tooth),
      neighbours: freeNeighbours(doc, tooth, view?.frame),
      needs: isImplantTooth(doc, tooth.fdi) ? IMPLANT_NEEDS : readinessNeeds(kind),
    })
      .concat(isImplantTooth(doc, tooth.fdi) ? implantReadiness(tooth, view?.implant, computing) : [])
      .map((i) => ({ ...i, id: `${tooth.fdi}-${i.id}`, ...(i.id === 'axis' && !axes ? { detail: 'Measuring…' } : {}) }));
    return { title: `${tooth.fdi} · ${kind === 'pontic' ? 'pontic' : 'crown'}`, items };
  });

  const checked = check.current ? check.result : null;
  const gate = checked ? bridgeGate(checked) : [];
  const connectorRows: ReadinessItem[] = bridge.connectors.map(({ between: [a, b] }) => {
    const id = `connector-${a}-${b}`;
    const label = `Connector ${a}–${b}`;
    const c = checked?.union?.checks.connectors.find((x) => x.between[0] === a && x.between[1] === b);
    if (!c) {
      // Not measured (no check yet, or the union failed); a failure of the connector's own design still counts.
      const designed = gate.filter((q) => q.id.startsWith(`bridge.connector.${a}-${b}.`) && !q.id.endsWith('.measured') && !q.passed).map((q) => q.message);
      if (designed.length) return { id, label, status: 'fail', detail: designed.join(' ') };
      return { id, label, status: 'unknown', detail: check.running ? 'Checking…' : checked ? 'Not measured: the bridge could not be merged' : 'Not checked yet' };
    }
    const status = gateStatus(gate, `bridge.connector.${a}-${b}`);
    const failures = [...c.failures.map((f) => f.message), ...(measuredConnector(checked, [a, b])?.failures ?? [])];
    return {
      id,
      label,
      status,
      detail:
        status === 'pass'
          ? `${mm2(c.measured.minAreaMm2)} smallest section (min ${mm2(Math.max(c.targetAreaMm2, c.minAreaMm2))}), ${mm(c.measured.heightMm, 1)} high (min ${mm(c.minHeightMm, 1)})`
          : failures.join(' '),
    };
  });
  const solidRows: ReadinessItem[] = checked
    ? unionRows(checked)
    : [{ id: 'union', label: 'One solid', status: 'unknown', detail: check.error ?? (check.running ? 'Merging the units and connectors…' : 'Not checked yet') }];
  groups.push({ title: `Bridge ${bridge.teeth[0]}–${bridge.teeth.at(-1)}`, items: [...connectorRows, ...solidRows] });

  const all = groups.flatMap((g) => g.items);
  const open = all.filter((i) => i.status !== 'pass');
  const ready = isReady(all);
  const exportable = Boolean(checked?.union);

  const exportStl = () => {
    const file = bridgeTool.export('stl');
    setConfirming(false);
    if (file) setExported({ file, at: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });
  };

  return (
    <div className="step-body">
      <section className="readiness" aria-labelledby="readiness-head">
        <div id="readiness-head" className={`readiness-head ${ready ? 'ready' : 'not-ready'}`}>
          {ready ? <CheckIcon /> : <AlertIcon />}
          {ready ? 'Ready to mill' : `Not ready to mill: ${open.length} ${open.length === 1 ? 'check' : 'checks'} open`}
        </div>
        {groups.map((g, i) => {
          // A unit whose checks all pass folds to one line; open checks and the bridge's own rows stay in view.
          const failing = g.items.filter((item) => item.status !== 'pass').length;
          const last = i === groups.length - 1;
          return (
            <details className="readiness-group" key={g.title} open={failing > 0 || last}>
              <summary className="readiness-group-title">
                {g.title}
                <span className={`readiness-count${failing ? ' open' : ''}`}>
                  {' · '}
                  {failing ? `${failing} open` : `${g.items.length} passed`}
                </span>
              </summary>
              <Rows items={g.items} />
            </details>
          );
        })}
      </section>
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
          <button className={`btn${ready ? ' primary' : ''}`} disabled={!exportable} onClick={ready ? exportStl : () => setConfirming(true)}>
            {ready ? 'Export STL' : 'Export STL anyway…'}
          </button>
          <button className="btn" disabled={!exportable} onClick={() => bridgeTool.export('info')}>
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
        One binary STL in millimetres: retainers, pontics and connectors merged into one solid. Construction info is a JSON file with each unit's
        frame, margin and pose, the common axis, the connectors as designed and as measured, and the checks.
      </p>
      <MapSelect />
      <CrownStatusView detailed />
    </div>
  );
}
