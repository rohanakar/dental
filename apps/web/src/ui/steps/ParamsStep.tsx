import { useState } from 'react';
import { DesignParams, MATERIAL_PRESETS, type DesignParams as Params } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { MATERIAL_LABEL } from './SetupStep';

type Field = { key: keyof Params; label: string; hint: string };

const GROUPS: Array<{ title: string; fields: Field[] }> = [
  {
    title: 'Fit',
    fields: [
      { key: 'cementGapMm', label: 'Cement gap', hint: 'Space for cement over the prep, ramping up from the margin.' },
      { key: 'extraSpacerMm', label: 'Extra spacer', hint: 'Added to the cement gap away from the margin.' },
      { key: 'distanceToMarginMm', label: 'Spacer starts at', hint: 'Distance from the margin where the extra spacer begins.' },
    ],
  },
  {
    title: 'Thickness',
    fields: [
      { key: 'marginThicknessMm', label: 'Margin thickness', hint: 'Crown edge thickness at the margin.' },
      { key: 'minThicknessMm', label: 'Minimum thickness', hint: 'Thinnest the material may be away from the margin; the crown is thickened to keep it.' },
    ],
  },
  {
    title: 'Contact targets',
    fields: [
      { key: 'occlusalClearanceMm', label: 'Occlusal clearance', hint: 'Target gap to the antagonist. Negative makes contact.' },
      { key: 'proximalContactMm', label: 'Proximal contact', hint: 'Target gap to the neighbours. Negative makes the contact tighter.' },
    ],
  },
  {
    title: 'Milling',
    fields: [{ key: 'toolRadiusMm', label: 'Milling tool radius', hint: 'Used only for the unmillable map.' }],
  },
];

/** Range of a numeric field from its zod schema, for the input's min/max. */
function range(key: keyof Params): { min?: number; max?: number } {
  const schema = DesignParams.shape[key] as unknown as { minValue?: number | null; maxValue?: number | null };
  return { min: schema.minValue ?? undefined, max: schema.maxValue ?? undefined };
}

/** Why a value was not applied, and what stayed in use. */
function rejected(key: keyof Params, raw: string, kept: number): string {
  const { min, max } = range(key);
  const span = min !== undefined && max !== undefined ? `${min}–${max} mm` : min !== undefined ? `at least ${min} mm` : `at most ${max} mm`;
  return `${raw === '' ? 'An empty value' : `${raw} mm`} is out of range (${span}). Kept ${kept} mm.`;
}

export function ParamsStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const material = useDesignStore((s) => s.doc.setup.teeth.find((t) => t.fdi === s.activeFdi)?.material);
  const [errors, setErrors] = useState<Partial<Record<keyof Params, string>>>({});
  if (!tooth) return null;
  const params = tooth.params;
  const fromPreset = material !== undefined && JSON.stringify(params) === JSON.stringify(MATERIAL_PRESETS[material]);

  /** Apply a valid value; otherwise put the field back to the value in use and say what is allowed. */
  const commit = (key: keyof Params, input: HTMLInputElement) => {
    const raw = input.value.trim();
    const value = Number(raw);
    const next = { ...params, [key]: value };
    const valid = raw !== '' && Number.isFinite(value) && DesignParams.safeParse(next).success;
    setErrors((e) => ({ ...e, [key]: valid ? undefined : rejected(key, raw, params[key]) }));
    if (!valid) {
      input.value = String(params[key]);
      return;
    }
    if (value !== params[key]) useDesignStore.getState().dispatch({ type: 'setParams', fdi: tooth.fdi, params: next });
  };

  return (
    <div className="step-body">
      <p className="muted">
        Values in millimetres{material ? `, ${fromPreset ? 'from' : 'changed from'} the ${MATERIAL_LABEL[material]} preset` : ''}. Changes
        recompute the crown.
      </p>
      <div className="param-grid">
        {GROUPS.map((group) => (
          <fieldset key={group.title}>
            <legend>{group.title}</legend>
            {group.fields.map(({ key, label, hint }) => {
              const { min, max } = range(key);
              const id = `param-${key}`;
              const error = errors[key];
              return (
                <div key={key} className="param-field">
                  <label htmlFor={id}>{label}</label>
                  <span className="unit-input">
                    {/* key on the value: undo/redo and preset resets refresh the uncontrolled input */}
                    <input
                      id={id}
                      key={`${key}:${params[key]}`}
                      type="number"
                      step={0.01}
                      min={min}
                      max={max}
                      defaultValue={params[key]}
                      aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
                      onBlur={(e) => commit(key, e.currentTarget)}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    />
                    <span className="unit" aria-hidden>
                      mm
                    </span>
                  </span>
                  <span id={`${id}-hint`} className="param-hint">
                    {hint}
                  </span>
                  {error && (
                    <span id={`${id}-error`} className="field-error" role="alert">
                      {error}
                    </span>
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
      </div>
      {material && (
        <div className="row">
          <button
            className="btn"
            disabled={fromPreset}
            onClick={() => {
              setErrors({});
              useDesignStore.getState().dispatch({ type: 'setParams', fdi: tooth.fdi, params: { ...MATERIAL_PRESETS[material] } });
            }}
          >
            Reset to the {MATERIAL_LABEL[material]} preset
          </button>
        </div>
      )}
    </div>
  );
}
