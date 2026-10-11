import { Material, type CaseSetup } from '@dcad/shared';
import { useState } from 'react';
import { createCase, useSessionStore } from '../../state/session';

/** Posterior teeth only (MVP scope): positions 4-8 in every quadrant. */
const POSTERIOR_FDI = [1, 2, 3, 4].flatMap((q) => [4, 5, 6, 7, 8].map((p) => q * 10 + p));

const MATERIAL_LABEL: Record<Material, string> = {
  zirconia: 'Zirconia',
  'lithium-disilicate': 'Lithium disilicate (e.max)',
  pmma: 'PMMA (temporary)',
};

export function NewCaseForm() {
  const [patientRef, setPatientRef] = useState('');
  const [fdi, setFdi] = useState(36);
  const [material, setMaterial] = useState<Material>('zirconia');
  const opening = useSessionStore((s) => s.opening);

  return (
    <form
      className="new-case"
      onSubmit={(e) => {
        e.preventDefault();
        const setup: CaseSetup = {
          patientRef: patientRef.trim(),
          teeth: [{ fdi, restoration: 'anatomic-crown', material }],
          notes: '',
        };
        void createCase(setup);
      }}
    >
      <div className="field">
        <label htmlFor="case-ref">Case reference (no patient names)</label>
        <input
          id="case-ref"
          type="text"
          maxLength={64}
          placeholder="e.g. LAB-2026-014"
          value={patientRef}
          onChange={(e) => setPatientRef(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="case-fdi">Tooth (FDI)</label>
        <select id="case-fdi" value={fdi} onChange={(e) => setFdi(Number(e.target.value))}>
          {POSTERIOR_FDI.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="case-material">Material</label>
        <select id="case-material" value={material} onChange={(e) => setMaterial(e.target.value as Material)}>
          {Material.options.map((m) => (
            <option key={m} value={m}>
              {MATERIAL_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      <button className="btn primary" type="submit" disabled={opening}>
        {opening ? 'Opening…' : 'New case'}
      </button>
    </form>
  );
}
