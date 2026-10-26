import {
  type CaseSetup,
  CUTBACK_DEFAULTS,
  CutbackMode,
  cutbackOf,
  isReduced,
  MAX_UNSUPPORTED_VENEER_MM,
  REDUCED_COUNTERPART,
  type RestorationType,
  unitKind,
  withReduced,
} from '@dcad/shared';
import { useState } from 'react';
import { selectActiveTooth, useDesignStore } from '../../design/store';
import { useBridgeStore } from '../../tools/bridgeTool';
import { frameworkTool, type FrameworkViewMode, useFrameworkStore } from '../../tools/frameworkTool';
import { userEdit } from '../../tools/nudge';
import { useToolStore } from '../../tools/toolStore';
import type { FrameworkView } from '../../workers/frameworkTypes';
import { CheckIcon } from '../icons';

/**
 * Framework restorations in the steps (specs/2026-10-25-framework-bridges.md): the Anatomic/Reduced switch in Setup,
 * the cutback panel in Adapt, and the framework rows and overpress exports in Finalize.
 */

const MODE_LABEL: Record<CutbackMode, string> = {
  full: 'Full: every surface but the collar',
  facial: 'Facial: buccal and the occlusal third',
  occlusal: 'Occlusal third only',
};
const VIEW_LABEL: Record<FrameworkViewMode, string> = { anatomy: 'Anatomy', framework: 'Framework', both: 'Both' };
const mm = (v: number, digits = 2) => `${v.toFixed(digits)} mm`;

const isReducedUnit = (setup: Pick<CaseSetup, 'teeth'>, fdi: number) => {
  const order = setup.teeth.find((t) => t.fdi === fdi);
  return Boolean(order && isReduced(order.restoration));
};

// ---- Setup ------------------------------------------------------------------------------------

/**
 * Anatomic or reduced (a framework for layered or pressed ceramic). Switching keeps the whole design; a reduced pontic
 * with overpress is a pressed pontic.
 */
export function ReducedSwitch({ fdi, onSet }: { fdi: number; onSet: (restoration: RestorationType) => void }) {
  const setup = useDesignStore((s) => s.doc.setup);
  const overpress = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === fdi)?.cutback?.overpress ?? CUTBACK_DEFAULTS.overpress);
  const order = setup.teeth.find((t) => t.fdi === fdi);
  // Only types with a reduced (or anatomic) counterpart switch: not an implant crown.
  if (!order || !REDUCED_COUNTERPART[order.restoration]) return null;
  const reduced = isReduced(order.restoration);
  const pressed = reduced && overpress && unitKind(setup, fdi) === 'pontic';
  const set = (to: boolean) => {
    const next = withReduced(order.restoration, to);
    if (next !== order.restoration) onSet(next);
  };
  return (
    <div className="seg" role="group" aria-label={`Anatomic or reduced ${fdi}`}>
      <button type="button" className="btn" aria-pressed={!reduced} onClick={() => set(false)} title="Full anatomic contour">
        Anatomic
      </button>
      <button type="button" className="btn" aria-pressed={reduced} onClick={() => set(true)} title="A framework, cut back for veneering">
        {pressed ? 'Pressed' : 'Reduced'}
      </button>
    </div>
  );
}

// ---- view controls ----------------------------------------------------------------------------------

/** Anatomy, framework or both (the anatomy as a ghost over the framework), and the veneer-space map. */
export function FrameworkViewControls() {
  const view = useFrameworkStore((s) => s.view);
  const veneerMap = useFrameworkStore((s) => s.veneerMap);
  return (
    <>
      <div className="seg" role="group" aria-label="Show anatomy, framework or both">
        {(['anatomy', 'framework', 'both'] as const).map((v) => (
          <button key={v} type="button" className="btn" aria-pressed={view === v} onClick={() => frameworkTool.setView(v)}>
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>
      <label className="row muted" title="Colour the framework by the porcelain space above it">
        <input type="checkbox" checked={veneerMap} disabled={view === 'anatomy'} onChange={(e) => frameworkTool.setVeneerMap(e.target.checked)} />
        Veneer-space map
      </label>
    </>
  );
}

// ---- the cutback report -------------------------------------------------------------------------------

/** Measured veneer space, the shortfall ("insufficient veneering space") and the framework's validity. */
function CutbackReport({ fdi, framework }: { fdi: number; framework: FrameworkView }) {
  const { stats, shortfall, validation, cutback } = framework;
  return (
    <>
      <span className="muted small">
        Veneer {mm(stats.minMm)}–{mm(stats.maxMm)} on the cut-back surface (requested {mm(cutback.thicknessMm, 1)})
        {Number.isFinite(stats.offsetWithinTolerance) ? `, ${Math.round(stats.offsetWithinTolerance * 100)}% within ±0.05 mm where offset` : ''}.
      </span>
      {shortfall && (
        <div className="warning">
          Insufficient veneering space on {fdi}: {shortfall.areaMm2.toFixed(1)} mm² where the framework minimum leaves less than{' '}
          {mm(cutback.thicknessMm, 1)} of porcelain (smallest {mm(shortfall.minVeneerMm)}). Reduce the prep there, or lower the cutback.
        </div>
      )}
      {stats.maxAnywhereMm > MAX_UNSUPPORTED_VENEER_MM && (
        <div className="warning">
          The porcelain reaches {mm(stats.maxAnywhereMm, 1)} over a thin or sharp feature (unsupported above {MAX_UNSUPPORTED_VENEER_MM} mm): check the
          incisal edge or cusp.
        </div>
      )}
      {!validation.printable && <div className="warning">The framework of {fdi} is not a printable solid ({validation.selfIntersections} self-intersections).</div>}
    </>
  );
}

// ---- Adapt ------------------------------------------------------------------------------------

/** The cutback of the active reduced unit: mode, veneering space, collar and overpress, with the measured report. */
export function CutbackPanel() {
  const tooth = useDesignStore(selectActiveTooth);
  const setup = useDesignStore((s) => s.doc.setup);
  const framework = useFrameworkStore((s) => (tooth ? s.units[tooth.fdi] : undefined));
  const computing = useToolStore((s) => s.crown?.computing ?? false);
  if (!tooth || !isReducedUnit(setup, tooth.fdi)) return null;
  return <CutbackFields key={tooth.fdi} fdi={tooth.fdi} cutback={cutbackOf(setup, tooth)!} framework={framework} computing={computing} />;
}

function CutbackFields({ fdi, cutback, framework, computing }: { fdi: number; cutback: NonNullable<ReturnType<typeof cutbackOf>>; framework?: FrameworkView; computing: boolean }) {
  const [thickness, setThickness] = useState(cutback.thicknessMm);
  const [collar, setCollar] = useState(cutback.collarMm);
  const edit = (patch: { mode?: CutbackMode; thicknessMm?: number; collarMm?: number; overpress?: boolean }) => userEdit({ type: 'setCutback', fdi, ...patch });
  const commitNumber = (key: 'thicknessMm' | 'collarMm', value: number, min: number, max: number) => {
    if (!Number.isFinite(value)) return;
    const v = Math.min(max, Math.max(min, Number(value.toFixed(2))));
    if (v !== cutback[key]) edit({ [key]: v });
  };
  return (
    <fieldset className="view-controls cutback" aria-labelledby="cutback-head">
      <legend id="cutback-head">Cutback for veneering ({fdi})</legend>
      <div className="field">
        <label htmlFor="cutback-mode">Cut back</label>
        <select id="cutback-mode" value={cutback.mode} onChange={(e) => edit({ mode: e.target.value as CutbackMode })}>
          {CutbackMode.options.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      <div className="adapt-row">
        <label className="param-field" title="Porcelain space: how far the anatomy is cut back (0.3–2.0 mm)">
          <span>Veneering space</span>
          <input
            type="number"
            step={0.1}
            min={0.3}
            max={2}
            value={thickness}
            aria-label="Veneering space (mm)"
            onChange={(e) => setThickness(Number(e.target.value))}
            onBlur={() => commitNumber('thicknessMm', thickness, 0.3, 2)}
            onKeyDown={(e) => e.key === 'Enter' && commitNumber('thicknessMm', thickness, 0.3, 2)}
          />
        </label>
        <label className="param-field" title="Collar above the margin kept at full contour (0–2 mm)">
          <span>Collar</span>
          <input
            type="number"
            step={0.1}
            min={0}
            max={2}
            value={collar}
            aria-label="Collar (mm)"
            onChange={(e) => setCollar(Number(e.target.value))}
            onBlur={() => commitNumber('collarMm', collar, 0, 2)}
            onKeyDown={(e) => e.key === 'Enter' && commitNumber('collarMm', collar, 0, 2)}
          />
        </label>
      </div>
      <label className="row muted" title="Also export the overpress part (anatomy minus framework) to press in wax">
        <input type="checkbox" checked={cutback.overpress} onChange={(e) => edit({ overpress: e.target.checked })} />
        Overpress part
      </label>
      {framework ? <CutbackReport fdi={fdi} framework={framework} /> : <span className="muted small">{computing ? 'Cutting back…' : 'No framework yet.'}</span>}
      <FrameworkViewControls />
    </fieldset>
  );
}

// ---- Finalize ---------------------------------------------------------------------------------------

/**
 * Framework rows and exports at Finalize: per reduced unit the framework's validity, its veneer space and any
 * shortfall; the overpress parts (a bridge's come with its check; a single crown's are made on export).
 */
export function FrameworkFinalize({ teeth }: { teeth: readonly number[] }) {
  const setup = useDesignStore((s) => s.doc.setup);
  const docTeeth = useDesignStore((s) => s.doc.teeth);
  const units = useFrameworkStore((s) => s.units);
  const busy = useFrameworkStore((s) => s.busy);
  const error = useFrameworkStore((s) => s.error);
  const check = useBridgeStore((s) => s.check);
  const [exported, setExported] = useState<string | null>(null);
  const reduced = teeth.filter((fdi) => isReducedUnit(setup, fdi));
  if (reduced.length === 0) return null;
  const bridge = teeth.length > 1;
  const overpressOf = (fdi: number) => (bridge && check.current ? check.result?.overpress?.find((o) => o.fdi === fdi) : undefined);
  const exportOverpress = async (fdi: number) => {
    const file = await frameworkTool.exportOverpress(fdi);
    setExported(file);
  };
  return (
    <section className="framework-finalize" aria-labelledby="framework-head">
      <h3 id="framework-head">Framework</h3>
      <p className="muted small">
        {bridge ? 'The exported bridge is the framework: the reduced units and their connectors.' : 'The exported STL is the framework.'} The overpress parts
        are the anatomy minus the framework, to press in wax.
      </p>
      {reduced.map((fdi) => {
        const framework = units[fdi];
        const tooth = docTeeth.find((t) => t.fdi === fdi);
        const cutback = tooth ? cutbackOf(setup, tooth) : undefined;
        const part = overpressOf(fdi);
        return (
          <div key={fdi} className="adapt-row">
            <strong>{fdi}</strong>
            {framework ? <CutbackReport fdi={fdi} framework={framework} /> : <span className="muted small">Not cut back yet.</span>}
            {cutback?.overpress && (
              <span className="row">
                <button
                  className="btn"
                  disabled={Boolean(busy) || (bridge && !part)}
                  title={bridge && !part ? 'The overpress parts come with the bridge check' : undefined}
                  onClick={() => void exportOverpress(fdi)}
                >
                  Overpress STL {fdi}
                </button>
                {part && <span className={`muted small${part.validation.printable ? '' : ' warning'}`}>{part.validation.printable ? `${part.volumeMm3.toFixed(1)} mm³` : 'not printable'}</span>}
              </span>
            )}
          </div>
        );
      })}
      {busy && <div className="muted small">{busy}</div>}
      {error && <div className="warning">{error}</div>}
      {exported && (
        <div className="export-done" role="status">
          <CheckIcon /> Exported {exported}
        </div>
      )}
      <FrameworkViewControls />
    </section>
  );
}
