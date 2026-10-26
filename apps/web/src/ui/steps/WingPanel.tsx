import {
  type CaseSetup,
  chartAdjacent,
  type DesignParams,
  normalizeConnections,
  RESTORATION_ROLE,
  type StepId,
  unitKind,
} from '@dcad/shared';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { useDesignStore } from '../../design/store';
import { useBridgeStore } from '../../tools/bridgeTool';
import { userEdit } from '../../tools/nudge';
import { isWing } from '../../tools/wing';
import { isCavity } from '../../tools/inlay';
import { INLAY_PARAM_DEFAULTS, INLAY_PARAM_GROUP } from './inlayParams';
import type { BridgeUnitView } from '../../workers/analysisTypes';
import { BridgeConnectors, BridgeResultPanel } from './BridgePanels';
import { CrownStatusView } from './CrownStatusView';
import { FocusControls, MapSelect } from './CrownViewControls';
import type { ReadinessItem } from './readiness';

/**
 * Maryland (resin-bonded) wings in the editor: the restoration type in Setup, the "Wing outline" step label, the wing
 * parameters, the Adapt panel (thickness, space against the antagonist, bonded and blocked-out area, connectors) and
 * the Finalize rows. The steps hook in with one line each; the logic lives here.
 */

/** Defaults of the wing parameters (DesignParams leaves them optional; geometry/wingUnit.ts applies the same). */
export const WING_PARAM_DEFAULTS: Partial<Record<keyof DesignParams, number>> = { wingThicknessMm: 0.7, wingEdgeThicknessMm: 0.2 };
/** Kern's minimum: the wing is never thinned below it to make room for the antagonist. */
const WING_MIN_MM = 0.5;

/** The Parameters step's group for a wing. */
export const WING_PARAM_GROUP: { title: string; fields: Array<{ key: keyof DesignParams; label: string; hint: string }> } = {
  title: 'Maryland wing',
  fields: [
    { key: 'wingThicknessMm', label: 'Wing thickness', hint: `Away from the edges. Never thinned below ${WING_MIN_MM} mm to make room for the antagonist.` },
    { key: 'wingEdgeThicknessMm', label: 'Edge thickness', hint: 'At the outline, rising to the wing thickness within 1 mm.' },
  ],
};

/** The parameter groups of a unit: a wing, an inlay or an onlay adds its own. */
export const paramGroupsFor = <G,>(setup: Pick<CaseSetup, 'teeth'>, fdi: number, groups: G[]): Array<G | typeof WING_PARAM_GROUP> =>
  isWing(setup, fdi) ? [...groups, WING_PARAM_GROUP] : isCavity(setup, fdi) ? [...groups, INLAY_PARAM_GROUP] : groups;

/** A parameter's value in use (an unset wing or inlay parameter shows its default). */
export const paramValue = (params: DesignParams, key: keyof DesignParams): number => params[key] ?? WING_PARAM_DEFAULTS[key] ?? INLAY_PARAM_DEFAULTS[key] ?? Number.NaN;

/** The step label for a unit: a wing's margin is its outline, an inlay's or onlay's the cavity margin. */
export const stepLabelFor = (setup: Pick<CaseSetup, 'teeth'>, fdi: number, id: StepId, label: string): string =>
  id !== 'margin' ? label : isWing(setup, fdi) ? 'Wing outline' : isCavity(setup, fdi) ? 'Cavity margin' : label;

/** What a unit is, in a word: crown, pontic, wing, inlay or onlay. */
export const unitName = (setup: Pick<CaseSetup, 'teeth'>, fdi: number): string => {
  if (isWing(setup, fdi)) return 'wing';
  if (isCavity(setup, fdi)) return setup.teeth.find((t) => t.fdi === fdi)!.restoration;
  return unitKind(setup, fdi) === 'pontic' ? 'pontic' : 'crown';
};

// ---- Setup ------------------------------------------------------------------------------------------

/**
 * Make a tooth a Maryland wing: connections it cannot have (to crowns) are dropped, and it connects to its chart
 * neighbours that are pontics of the same material, as a pontic connects to its neighbours.
 */
export function setWing(setup: CaseSetup, fdi: number): CaseSetup {
  const teeth = setup.teeth.map((t) => (t.fdi === fdi ? { ...t, restoration: 'maryland-wing' as const } : t));
  const order = new Map(teeth.map((t) => [t.fdi, t] as const));
  const allowed = RESTORATION_ROLE['maryland-wing'].connectsTo!;
  const kept = setup.connections.filter(([a, b]) => !(a === fdi || b === fdi) || allowed.includes(order.get(a === fdi ? b : a)!.restoration));
  const self = order.get(fdi)!;
  const pontics = teeth
    .filter((t) => RESTORATION_ROLE[t.restoration].role === 'pontic' && t.material === self.material && chartAdjacent(t.fdi, fdi))
    .map((t): [number, number] => [fdi, t.fdi]);
  return { ...setup, teeth, connections: normalizeConnections([...kept, ...pontics]) };
}

/** "Wing" in a unit's restoration switch: offered on a tooth next to a pontic in the case (or already a wing). */
export function WingButton({ setup, fdi, commit }: { setup: CaseSetup; fdi: number; commit(next: CaseSetup, title: string): boolean }) {
  const wing = isWing(setup, fdi);
  const nextToPontic = setup.teeth.some((t) => RESTORATION_ROLE[t.restoration].role === 'pontic' && chartAdjacent(t.fdi, fdi));
  if (!wing && !nextToPontic) return null;
  return (
    <button
      type="button"
      className="btn"
      aria-pressed={wing}
      title="Resin-bonded (Maryland) wing on the unprepared lingual surface"
      onClick={() => !wing && commit(setWing(setup, fdi), `${fdi} was not made a Maryland wing`)}
    >
      Wing
    </button>
  );
}

// ---- Adapt ------------------------------------------------------------------------------------------

const mm = (v: number, digits = 2) => (Number.isFinite(v) ? `${(Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits)} mm` : '–');
const mm2 = (v: number) => `${v.toFixed(1)} mm²`;

/** A wing parameter field, committed on blur or Enter as one setParam (one undo entry). */
function WingParamField({ fdi, name, label, value, min, max }: { fdi: number; name: 'wingThicknessMm' | 'wingEdgeThicknessMm'; label: string; value: number; min: number; max: number }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n === value) return setDraft(String(value));
    userEdit({ type: 'setParam', fdi, name, value: Math.min(max, Math.max(min, n)) });
  };
  return (
    <label className="connector-field">
      <span>{label}</span>
      <span className="unit-input">
        <input
          type="number"
          min={min}
          max={max}
          step={0.05}
          value={draft}
          aria-label={`${label} (mm)`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="unit">mm</span>
      </span>
    </label>
  );
}

/** The active wing's report: thickness, space against the antagonist, bonded and blocked-out area, the outline's seat. */
export function WingReport({ unit }: { unit: BridgeUnitView }) {
  const w = unit.wing;
  const params = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === unit.fdi)?.params);
  if (!w || !params) return null;
  const s = w.space;
  const thin = w.thickness.samples > 0 && w.thickness.minMm < w.params.wingMinThicknessMm - 0.02;
  const undercut = w.blockout.outlineUndercutPoints > 0 || w.blockout.undercutFaces > 0;
  return (
    <section className="bridge-panel" aria-labelledby="wing-head">
      <h3 id="wing-head">Wing {unit.fdi}</h3>
      <div className="connector-fields">
        <WingParamField fdi={unit.fdi} name="wingThicknessMm" label="Thickness" value={paramValue(params, 'wingThicknessMm')} min={WING_MIN_MM} max={1.5} />
        <WingParamField fdi={unit.fdi} name="wingEdgeThicknessMm" label="Edge" value={paramValue(params, 'wingEdgeThicknessMm')} min={0.05} max={0.5} />
      </div>
      <dl className="params">
        <dt>Thickness</dt>
        <dd className={thin ? 'bad' : undefined}>
          {w.thickness.samples > 0 ? `${mm(w.thickness.minMm)} – ${mm(w.thickness.maxMm)}` : 'never full: narrower than 2 mm'}{' '}
          <span className="muted">/ min {mm(w.params.wingMinThicknessMm, 1)}, edge {mm(w.thickness.rampMinMm)}</span>
        </dd>
        <dt>Space to antagonist</dt>
        <dd className={s?.conflict ? 'bad' : undefined}>
          {s ? `${mm(s.minClearanceMm)} closest` : 'no antagonist scan'} {s && <span className="muted">/ target {mm(s.targetMm)}</span>}
        </dd>
        <dt>Bonded area</dt>
        <dd>{mm2(w.area.bondedMm2)}</dd>
        <dt>Blocked out</dt>
        <dd className={w.area.blockedOutMm2 > 0 ? 'warn' : undefined}>
          {mm2(w.area.blockedOutMm2)} <span className="muted">({(100 * w.area.blockedOutFraction).toFixed(0)}% of {mm2(w.area.patchMm2)})</span>
        </dd>
        <dt>Fitting gap</dt>
        <dd>
          {mm(w.fit.meanMm, 3)} <span className="muted">/ cement gap {mm(w.params.cementGapMm, 2)}</span>
        </dd>
      </dl>
      {s?.conflict && (
        <div className="warning">
          Insufficient space for the wing: {mm2(s.conflict.areaMm2)} stays {mm(s.conflict.minClearanceMm)} from the antagonist with the wing at
          its minimum (red marker). A minimal prep or an occlusal adjustment is needed.
        </div>
      )}
      {!s?.conflict && s?.thinning && s.thinning.vertices > 0 && (
        <div className="muted small">
          Thinned locally by up to {mm(s.thinning.maxMm)} over {mm2(s.thinning.areaMm2)} to keep {mm(s.targetMm)} from the antagonist.
        </div>
      )}
      {undercut && (
        <div className="warning">
          {w.blockout.outlineUndercutPoints > 0 && `${w.blockout.outlineUndercutPoints} outline points are in an undercut along the insertion axis. `}
          {w.blockout.undercutFaces > 0 && `${mm2(w.blockout.undercutAreaMm2)} inside the outline is undercut. `}
          Move the outline or change the axis.
        </div>
      )}
    </section>
  );
}

/** Adapt step for a wing: the wing is derived from its outline, so there is no occlusion or contact adaptation to run. */
export function WingAdapt() {
  const activeFdi = useDesignStore((s) => s.activeFdi);
  const unit = useBridgeStore((s) => s.result?.units.find((u) => u.fdi === activeFdi));
  return (
    <div className="step-body">
      <p className="muted">
        The wing follows the outline at the wing thickness, feathered to the edge thickness. Where the antagonist is closer than the target, the
        wing is thinned toward 0.5 mm; below that, the space conflict is reported.
      </p>
      <BridgeResultPanel />
      {unit ? <WingReport unit={unit} /> : <div className="muted">Computing the wing…</div>}
      <CrownStatusView />
      <BridgeConnectors />
      <fieldset className="view-controls">
        <legend>View</legend>
        <MapSelect />
        <FocusControls />
      </fieldset>
    </div>
  );
}

// ---- Finalize ---------------------------------------------------------------------------------------

/**
 * Finalize rows of a wing: the outline closes a region on the tooth (the wing was built on it), it seats along the
 * axis, there is space for the wing, and the bonded area.
 */
export function wingReadinessRows(unit: BridgeUnitView | undefined, outline?: ReadonlyArray<{ p: readonly number[] }>): ReadinessItem[] {
  const w = unit?.wing;
  if (!unit || !w) return [];
  const id = (k: string) => `${unit.fdi}-wing-${k}`;
  const undercut = w.blockout.outlineUndercutPoints + w.blockout.undercutFaces;
  let lengthMm = 0;
  for (let i = 0; outline && i < outline.length; i++) {
    const a = outline[i]!.p, b = outline[(i + 1) % outline.length]!.p;
    lengthMm += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  }
  return [
    {
      id: id('outline'),
      label: 'Wing outline closed',
      status: lengthMm > 0 ? 'pass' : 'fail',
      detail: lengthMm > 0 ? `Closed on the tooth, ${lengthMm.toFixed(1)} mm${w.outlineDroppedVertices ? `, ${w.outlineDroppedVertices} spur vertices dropped` : ''}` : 'No outline drawn',
    },
    {
      id: id('seat'),
      label: 'Wing seats along the axis',
      status: undercut === 0 ? 'pass' : 'fail',
      detail: undercut === 0 ? 'No undercut inside the outline' : `${w.blockout.outlineUndercutPoints} outline points and ${mm2(w.blockout.undercutAreaMm2)} undercut`,
    },
    {
      id: id('space'),
      label: 'Space for the wing',
      status: w.space ? (w.space.conflict ? 'fail' : 'pass') : 'unknown',
      detail: w.space ? (w.space.conflict ? `Insufficient: ${mm(w.space.conflict.minClearanceMm)} to the antagonist` : `${mm(w.space.minClearanceMm)} to the antagonist`) : 'No antagonist scan',
    },
    {
      id: id('bonded'),
      label: 'Bonded area',
      status: w.area.bondedMm2 > 0 ? 'pass' : 'fail',
      detail: `${mm2(w.area.bondedMm2)}, ${(100 * w.area.blockedOutFraction).toFixed(0)}% blocked out`,
    },
  ];
}
