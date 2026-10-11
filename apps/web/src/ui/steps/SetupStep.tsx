import { type CaseSetup, Material, MATERIAL_PRESETS, type ToothOrder } from '@dcad/shared';
import { useState } from 'react';
import { useDesignStore } from '../../design/store';
import { ToothChart } from '../ToothChart';

export const MATERIAL_LABEL: Record<Material, string> = {
  zirconia: 'Zirconia',
  'lithium-disilicate': 'Lithium disilicate (e.max)',
  pmma: 'PMMA (temporary)',
};

function dispatchSetup(setup: CaseSetup) {
  try {
    useDesignStore.getState().dispatch({ type: 'setCaseSetup', setup });
  } catch (e) {
    console.error(e);
  }
}

export function SetupStep() {
  const setup = useDesignStore((s) => s.doc.setup);
  const activeFdi = useDesignStore((s) => s.activeFdi);
  const [error, setError] = useState<string | null>(null);
  const active = setup.teeth.find((t) => t.fdi === activeFdi) ?? setup.teeth[0];
  const params = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === activeFdi)?.params);

  const toggle = (fdi: number) => {
    const exists = setup.teeth.some((t) => t.fdi === fdi);
    if (exists && setup.teeth.length === 1) {
      setError('A case needs at least one tooth.');
      return;
    }
    setError(null);
    const material = active?.material ?? 'zirconia';
    const teeth: ToothOrder[] = exists
      ? setup.teeth.filter((t) => t.fdi !== fdi)
      : [...setup.teeth, { fdi, restoration: 'anatomic-crown' as const, material }].sort((a, b) => a.fdi - b.fdi);
    dispatchSetup({ ...setup, teeth });
    if (!exists) useDesignStore.getState().setActiveFdi(fdi);
  };

  const setMaterial = (material: Material) => {
    if (!active) return;
    dispatchSetup({ ...setup, teeth: setup.teeth.map((t) => (t.fdi === active.fdi ? { ...t, material } : t)) });
  };

  return (
    <div className="step-body">
      <p className="muted">Select the teeth to restore. Anatomic crowns on premolars and molars only.</p>
      <ToothChart selected={setup.teeth.map((t) => t.fdi)} active={active?.fdi} onToggle={toggle} />
      {error && <div className="error">{error}</div>}
      {active && (
        <>
          <div className="field">
            <label htmlFor="material">Material for {active.fdi}</label>
            <select id="material" value={active.material} onChange={(e) => setMaterial(e.target.value as Material)}>
              {Material.options.map((m) => (
                <option key={m} value={m}>
                  {MATERIAL_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          {params && (
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
          )}
          {params && JSON.stringify(params) !== JSON.stringify(MATERIAL_PRESETS[active.material]) && (
            <div className="muted">Parameters differ from the {MATERIAL_LABEL[active.material]} preset.</div>
          )}
        </>
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
          onBlur={(e) => e.target.value !== setup.patientRef && dispatchSetup({ ...setup, patientRef: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>
    </div>
  );
}
