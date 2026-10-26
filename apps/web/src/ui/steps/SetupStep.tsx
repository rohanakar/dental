import {
  archOrder,
  type BridgeIssueCode,
  bridgesOf,
  type CaseSetup,
  chartAdjacent,
  type FdiPair,
  isReduced,
  Material,
  MATERIAL_PRESETS,
  normalizeConnections,
  pairKey,
  RESTORATION_ROLE,
  type RestorationType,
  unitKind,
  validateBridges,
  withReduced,
} from '@dcad/shared';
import { useState } from 'react';
import { useDesignStore } from '../../design/store';
import { RxIntake } from '../ai/RxIntake';
import { SeparateHint } from '../SeparateHint';
import { connectorState, ToothChart } from '../ToothChart';
import { ReducedSwitch } from './FrameworkPanels';
import '../bridge.css';
import { isWing } from '../../tools/wing';
import { WingButton } from './WingPanel';
import { InlayButtons } from './InlayPanel';
import { isCavity } from '../../tools/inlay';

export const MATERIAL_LABEL: Record<Material, string> = {
  zirconia: 'Zirconia',
  'lithium-disilicate': 'Lithium disilicate (e.max)',
  pmma: 'PMMA (temporary)',
  cocr: 'CoCr (metal framework)',
  titanium: 'Titanium (framework)',
};

// ---- setup edits (pure) -----------------------------------------------------------------------

const withConnections = (setup: CaseSetup, pairs: readonly FdiPair[]): CaseSetup => ({
  ...setup,
  connections: normalizeConnections([...setup.connections, ...pairs]),
});

/** Chart neighbours of a tooth that are in the case and can be connected to it (same material, as in exocad). */
const connectableNeighbours = (setup: CaseSetup, fdi: number): number[] =>
  setup.teeth.filter((t) => chartAdjacent(t.fdi, fdi) && connectorState(setup, fdi, t.fdi)?.status === 'open').map((t) => t.fdi);

export function addTooth(setup: CaseSetup, fdi: number, material: Material): CaseSetup {
  const next = { ...setup, teeth: [...setup.teeth, { fdi, restoration: 'anatomic-crown' as const, material }].sort((a, b) => a.fdi - b.fdi) };
  // A pontic's connectors appear automatically: a tooth added next to one joins its bridge.
  const pontics = connectableNeighbours(next, fdi).filter((n) => unitKind(next, n) === 'pontic');
  return withConnections(next, pontics.map((p): FdiPair => [fdi, p]));
}

/** Its connections leave with it. */
export const removeTooth = (setup: CaseSetup, fdi: number): CaseSetup => ({
  ...setup,
  teeth: setup.teeth.filter((t) => t.fdi !== fdi),
  connections: setup.connections.filter((p) => !p.includes(fdi)),
});

/** Making a tooth a pontic connects it to its neighbours in the case with the same material; the toggles can undo that. */
export function setRestoration(setup: CaseSetup, fdi: number, restoration: RestorationType): CaseSetup {
  const next = { ...setup, teeth: setup.teeth.map((t) => (t.fdi === fdi ? { ...t, restoration } : t)) };
  if (RESTORATION_ROLE[restoration].role !== 'pontic') return next;
  return withConnections(next, connectableNeighbours(next, fdi).map((n): FdiPair => [fdi, n]));
}

export function toggleConnection(setup: CaseSetup, a: number, b: number): CaseSetup {
  const key = pairKey([a, b]);
  const connected = setup.connections.some((p) => pairKey(p) === key);
  return connected ? { ...setup, connections: setup.connections.filter((p) => pairKey(p) !== key) } : withConnections(setup, [[a, b]]);
}

/** A bridge has one material: every unit changes together, so the mixed-material rule never trips. */
export const setMaterial = (setup: CaseSetup, teeth: readonly number[], material: Material): CaseSetup => ({
  ...setup,
  teeth: setup.teeth.map((t) => (teeth.includes(t.fdi) ? { ...t, material } : t)),
});

/** What to do about a refused setup, once per rule. */
const FIX: Partial<Record<BridgeIssueCode, string>> = {
  'unconnected-pontic': 'A pontic needs at least one connected neighbour in the case.',
  'no-abutment': 'Every bridge needs at least one crown on a prepared tooth.',
  'mixed-materials': 'Give both teeth the same material first.',
};

interface Problem {
  title: string;
  messages: string[];
}

// ---- step -----------------------------------------------------------------------------------------

export function SetupStep() {
  const setup = useDesignStore((s) => s.doc.setup);
  const activeFdi = useDesignStore((s) => s.activeFdi);
  const params = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === s.activeFdi)?.params);
  const [problem, setProblem] = useState<Problem | null>(null);
  const active = setup.teeth.find((t) => t.fdi === activeFdi) ?? setup.teeth[0];

  /** Check the bridges first and show why a setup is refused; never drop a dispatch error. */
  const commit = (next: CaseSetup, title: string): boolean => {
    const { errors } = validateBridges(next);
    if (errors.length) {
      const fixes = [...new Set(errors.map((e) => FIX[e.code]).filter((f): f is string => Boolean(f)))];
      setProblem({ title, messages: [...errors.map((e) => `${e.message}.`), ...fixes] });
      return false;
    }
    try {
      useDesignStore.getState().dispatch({ type: 'setCaseSetup', setup: next });
    } catch (e) {
      setProblem({ title, messages: [e instanceof Error ? e.message : String(e)] });
      return false;
    }
    setProblem(null);
    return true;
  };

  const toggleTooth = (fdi: number) => {
    if (!setup.teeth.some((t) => t.fdi === fdi)) {
      if (commit(addTooth(setup, fdi, active?.material ?? 'zirconia'), `${fdi} was not added`)) useDesignStore.getState().setActiveFdi(fdi);
    } else if (setup.teeth.length === 1) setProblem({ title: `${fdi} was not removed`, messages: ['A case needs at least one tooth.'] });
    else commit(removeTooth(setup, fdi), `${fdi} was not removed`);
  };

  // Bridges and single units, in arch order.
  const bridges = bridgesOf(setup);
  const bridged = new Set(bridges.flat());
  const singles = setup.teeth.map((t) => t.fdi).filter((fdi) => !bridged.has(fdi));
  const groups = archOrder([...bridges.map((b) => b[0]!), ...singles]).map((first) => bridges.find((b) => b[0] === first) ?? [first]);
  const { warnings } = validateBridges(setup);

  const kindSwitch = (fdi: number) => {
    const pontic = unitKind(setup, fdi) === 'pontic';
    const restoration = setup.teeth.find((t) => t.fdi === fdi)?.restoration ?? 'anatomic-crown';
    const implant = restoration === 'implant-crown';
    const wing = restoration === 'maryland-wing';
    const cavity = isCavity(setup, fdi);
    // A reduced unit stays reduced when it switches between crown and pontic.
    const reduced = isReduced(restoration);
    const set = (restoration: RestorationType) =>
      commit(
        setRestoration(setup, fdi, withReduced(restoration, reduced)),
        `${fdi} was not made a ${restoration === 'pontic' ? 'pontic' : restoration === 'implant-crown' ? 'implant crown' : 'crown'}`,
      );
    return (
      <>
        <div className="seg" role="group" aria-label={`Restoration for ${fdi}`}>
          <button type="button" className="btn" aria-pressed={!pontic && !implant && !wing && !cavity} onClick={() => (pontic || implant || wing || cavity) && set('anatomic-crown')}>
            Crown
          </button>
          <InlayButtons setup={setup} fdi={fdi} commit={commit} />
          <WingButton setup={setup} fdi={fdi} commit={commit} />
          <button type="button" className="btn" aria-pressed={implant} title="Screw-retained on a Ti-base" onClick={() => !implant && set('implant-crown')}>
            Implant
          </button>
          <button type="button" className="btn" aria-pressed={pontic} onClick={() => !pontic && set('pontic')}>
            Pontic
          </button>
        </div>
        <ReducedSwitch fdi={fdi} onSet={(r) => commit(setRestoration(setup, fdi, r), `${fdi} was not switched`)} />
      </>
    );
  };

  const unitName = (fdi: number) => (
    <button
      type="button"
      className="unit-fdi"
      aria-current={fdi === active?.fdi ? 'true' : undefined}
      title={`Make ${fdi} the active tooth`}
      onClick={() => useDesignStore.getState().setActiveFdi(fdi)}
    >
      {fdi}
    </button>
  );

  const materialSelect = (teeth: number[], name: string) => {
    const material = setup.teeth.find((t) => t.fdi === teeth[0])!.material;
    return (
      <select
        className="unit-material"
        aria-label={`Material for ${name}`}
        value={material}
        onChange={(e) => commit(setMaterial(setup, teeth, e.target.value as Material), `The material of ${name} was not changed`)}
      >
        {Material.options.map((m) => (
          <option key={m} value={m}>
            {MATERIAL_LABEL[m]}
          </option>
        ))}
      </select>
    );
  };

  return (
    <div className="step-body">
      <RxIntake />
      <p className="muted">
        Select the teeth to restore. Mark a missing tooth as a pontic: it connects to its neighbours, and the dots
        between teeth switch each connector on or off.
      </p>
      <ToothChart
        setup={setup}
        active={active?.fdi}
        onToggleTooth={toggleTooth}
        onToggleConnector={(a, b) => {
          const connected = connectorState(setup, a, b)?.status === 'connected';
          commit(toggleConnection(setup, a, b), `${a}–${b} was not ${connected ? 'disconnected' : 'connected'}`);
        }}
        onUnavailable={(reason, code) => setProblem({ title: 'Connector unavailable', messages: [reason, ...(FIX[code] ? [FIX[code]] : [])] })}
      />
      <SeparateHint setup={setup} />
      {problem && (
        <div className="setup-problem" role="alert">
          <strong>{problem.title}.</strong>
          <ul>
            {problem.messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="units" aria-labelledby="units-head">
        <h3 id="units-head">Restorations</h3>
        <ul className="unit-groups">
          {groups.map((teeth) => {
            const bridge = teeth.length > 1;
            const name = bridge ? `bridge ${teeth[0]}–${teeth.at(-1)}` : `${teeth[0]}`;
            return bridge ? (
              <li key={teeth.join('-')} className="unit-group bridge">
                <div className="unit-head">
                  <span className="unit-group-name">
                    Bridge {teeth[0]}–{teeth.at(-1)}
                  </span>
                  {materialSelect(teeth, name)}
                </div>
                <ul>
                  {teeth.map((fdi) => (
                    <li key={fdi} className={`unit-row${fdi === active?.fdi ? ' active' : ''}`}>
                      {unitName(fdi)}
                      {kindSwitch(fdi)}
                    </li>
                  ))}
                </ul>
              </li>
            ) : (
              <li key={teeth[0]} className={`unit-group unit-row${teeth[0] === active?.fdi ? ' active' : ''}`}>
                {unitName(teeth[0]!)}
                {kindSwitch(teeth[0]!)}
                {materialSelect(teeth, name)}
              </li>
            );
          })}
        </ul>
        {warnings.map((w) => (
          <div key={w.code + w.teeth.join('-')} className="warning">
            {w.message}. It can still be designed: check the material's instructions for use.
          </div>
        ))}
      </section>

      {active && params && (
        <section aria-labelledby="params-head">
          <h3 id="params-head">
            Parameters for {active.fdi}, {MATERIAL_LABEL[active.material]}
          </h3>
          <dl className="params">
            <dt>Cement gap</dt>
            <dd>{params.cementGapMm.toFixed(2)} mm</dd>
            <dt>Extra spacer</dt>
            <dd>
              {params.extraSpacerMm.toFixed(2)} mm from {params.distanceToMarginMm.toFixed(1)} mm
            </dd>
            <dt>Margin thickness</dt>
            <dd>{params.marginThicknessMm.toFixed(2)} mm</dd>
            <dt>Min thickness</dt>
            <dd>{params.minThicknessMm.toFixed(2)} mm</dd>
          </dl>
          {JSON.stringify(params) !== JSON.stringify(MATERIAL_PRESETS[active.material]) && (
            <div className="muted">Parameters differ from the {MATERIAL_LABEL[active.material]} preset.</div>
          )}
        </section>
      )}
      <div className="field">
        <label htmlFor="patient-ref">Patient reference (pseudonymous, never a name)</label>
        {/* Committed on blur/Enter so typing does not create one undo entry per keystroke. */}
        <input
          id="patient-ref"
          key={setup.patientRef}
          defaultValue={setup.patientRef}
          maxLength={64}
          placeholder="e.g. LAB-2026-0142"
          onBlur={(e) => e.target.value !== setup.patientRef && commit({ ...setup, patientRef: e.target.value }, 'The reference was not saved')}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>
    </div>
  );
}
