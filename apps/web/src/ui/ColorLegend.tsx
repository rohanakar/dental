import { COLOR_MAPS, cssGradient, rangeT } from '../engine/colormap';
import { useToolStore } from '../tools/toolStore';

/** Legend for the active colour-map overlay; drawn over the viewport, with the same stops as the surface. */
export function ColorLegend() {
  const legend = useToolStore((s) => s.legend);
  if (!legend) return null;
  const [lo, hi] = legend.range;
  const ticks = legend.ticks ?? [];
  const summary = [`${legend.title}: ${lo} to ${hi} ${legend.unit}`, ...ticks.map((t) => t.label)].join('; ');
  return (
    <div className="legend" role="img" aria-label={summary}>
      <div className="legend-title">{legend.title}</div>
      <div className="legend-bar" style={{ background: cssGradient(legend.stops ?? COLOR_MAPS[legend.map]) }}>
        {ticks.map((t) => (
          <span key={t.label} className={`legend-tick${t.dashed ? ' dashed' : ''}`} style={{ left: `${rangeT(legend.range, t.value) * 100}%` }} />
        ))}
      </div>
      <div className="legend-ticks">
        <span>
          {lo} {legend.unit}
          {legend.lowLabel && <em> {legend.lowLabel}</em>}
        </span>
        <span>
          ≥ {hi} {legend.unit}
          {legend.highLabel && <em> {legend.highLabel}</em>}
        </span>
      </div>
      {ticks.length > 0 && (
        <ul className="legend-key">
          {ticks.map((t) => (
            <li key={t.label}>
              <span className={`mark${t.dashed ? ' dashed' : ''}`} />
              {t.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
