import { COLOR_MAPS, cssGradient } from '../engine/colormap';
import { useToolStore } from '../tools/toolStore';

/** Legend for the active colour-map overlay; drawn over the viewport. */
export function ColorLegend() {
  const legend = useToolStore((s) => s.legend);
  if (!legend) return null;
  const [lo, hi] = legend.range;
  return (
    <div className="legend" role="img" aria-label={`${legend.title}: ${lo} to ${hi} ${legend.unit}`}>
      <div className="legend-title">{legend.title}</div>
      <div className="legend-bar" style={{ background: cssGradient(COLOR_MAPS[legend.map]) }} />
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
    </div>
  );
}
