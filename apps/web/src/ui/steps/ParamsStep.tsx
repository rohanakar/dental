import { DesignParams, MATERIAL_PRESETS, type DesignParams as Params } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';

const FIELDS: Array<{ key: keyof Params; label: string; hint: string }> = [
  { key: 'cementGapMm', label: 'Cement gap', hint: 'Space for cement on the whole prep (after a short ramp from the margin)' },
  { key: 'extraSpacerMm', label: 'Extra spacer', hint: 'Added on top of the cement gap away from the margin' },
  { key: 'distanceToMarginMm', label: 'Spacer starts at', hint: 'Distance from the margin where the extra spacer begins' },
  { key: 'marginThicknessMm', label: 'Margin thickness', hint: 'Crown edge thickness at the margin' },
  { key: 'minThicknessMm', label: 'Minimum thickness', hint: 'Material minimum away from the margin (enforced on Day 4)' },
  { key: 'toolRadiusMm', label: 'Milling tool radius', hint: 'Used only for the "unmillable" map' },
  { key: 'occlusalClearanceMm', label: 'Occlusal clearance', hint: 'Target gap to the antagonist (negative = contact)' },
  { key: 'proximalContactMm', label: 'Proximal contact', hint: 'Target gap to the neighbours (negative = tighter)' },
];

/** Range of a numeric field from its zod schema, for the input's min/max. */
function range(key: keyof Params): { min?: number; max?: number } {
  const schema = DesignParams.shape[key] as unknown as { minValue?: number | null; maxValue?: number | null };
  return { min: schema.minValue ?? undefined, max: schema.maxValue ?? undefined };
}

export function ParamsStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const material = useDesignStore((s) => s.doc.setup.teeth.find((t) => t.fdi === s.activeFdi)?.material);
  if (!tooth) return null;
  const params = tooth.params;

  const commit = (key: keyof Params, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value === params[key]) return;
    const next = { ...params, [key]: value };
    if (!DesignParams.safeParse(next).success) return;
    useDesignStore.getState().dispatch({ type: 'setParams', fdi: tooth.fdi, params: next });
  };

  return (
    <div className="step-body">
      <p className="muted">All values in mm. Changes recompute the crown.</p>
      <div className="param-grid">
        {FIELDS.map(({ key, label, hint }) => {
          const { min, max } = range(key);
          return (
            <label key={key} className="param-field" title={hint}>
              <span>{label}</span>
              {/* key on the value: undo/redo and preset resets refresh the uncontrolled input */}
              <input
                key={`${key}:${params[key]}`}
                type="number"
                step={0.01}
                min={min}
                max={max}
                defaultValue={params[key]}
                onBlur={(e) => commit(key, e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </label>
          );
        })}
      </div>
      {material && (
        <div className="row">
          <button
            className="btn"
            disabled={JSON.stringify(params) === JSON.stringify(MATERIAL_PRESETS[material])}
            onClick={() => useDesignStore.getState().dispatch({ type: 'setParams', fdi: tooth.fdi, params: { ...MATERIAL_PRESETS[material] } })}
          >
            Reset to material preset
          </button>
        </div>
      )}
    </div>
  );
}
