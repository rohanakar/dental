import { useToolStore } from '../../tools/toolStore';

/**
 * The cross-section under the cursor (specs/2026-10-27-margin-review-ux.md): the scan's profile through the point
 * under the cursor, across the margin (outward to the right, occlusal up), with the margin's own place marked. It is
 * how a technician judges where a finish line or a gum line really is.
 */
export function MarginSection() {
  const on = useToolStore((s) => s.sectionView);
  const section = useToolStore((s) => s.section);
  return (
    <div className="margin-section">
      <label className="row small">
        <input type="checkbox" checked={on} onChange={(e) => useToolStore.getState().set({ sectionView: e.target.checked, ...(e.target.checked ? {} : { section: null }) })} />
        Cross-section under the cursor
      </label>
      {on && (section ? <SectionPlot section={section} /> : <p className="muted small">Move the cursor over the tooth.</p>)}
    </div>
  );
}

function SectionPlot({ section }: { section: NonNullable<ReturnType<typeof useToolStore.getState>['section']> }) {
  const h = section.halfMm;
  const s = section.segments;
  let d = '';
  for (let i = 0; i + 3 < s.length; i += 4) d += `M${s[i]!.toFixed(3)} ${(-s[i + 1]!).toFixed(3)}L${s[i + 2]!.toFixed(3)} ${(-s[i + 3]!).toFixed(3)}`;
  const grid = Array.from({ length: 2 * Math.floor(h) + 1 }, (_, k) => k - Math.floor(h));
  return (
    <svg className="section-plot" viewBox={`${-h} ${-h} ${2 * h} ${2 * h}`} role="img" aria-label="Cross-section of the scan under the cursor, with the margin marked">
      {grid.map((g) => (
        <g key={g} className="section-grid">
          <line x1={g} x2={g} y1={-h} y2={h} />
          <line y1={g} y2={g} x1={-h} x2={h} />
        </g>
      ))}
      <path className="section-profile" d={d} />
      {section.marks.map(([ms, mh], i) => (
        <circle key={i} className="section-margin" cx={ms} cy={-mh} r={0.13} />
      ))}
      <g className="section-cursor">
        <line x1={-0.3} x2={0.3} y1={0} y2={0} />
        <line y1={-0.3} y2={0.3} x1={0} x2={0} />
      </g>
      <text className="section-label" x={h - 0.15} y={h - 0.2} textAnchor="end">
        outward →
      </text>
      <text className="section-label" x={-h + 0.15} y={-h + 0.45}>
        ↑ occlusal · grid 1 mm
      </text>
    </svg>
  );
}
