import { useDesignStore, selectActiveTooth } from '../../design/store';
import { marginTool } from '../../tools/marginTool';
import { useToolStore } from '../../tools/toolStore';

function polylineLength(points: ReadonlyArray<{ p: readonly number[] }>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!.p;
    const b = points[(i + 1) % points.length]!.p;
    sum += Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  }
  return sum;
}

export function MarginStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const anchors = useToolStore((s) => s.marginAnchors);
  const surface = useToolStore((s) => s.surface);
  if (!tooth) return null;
  if (!tooth.frame) return <div className="step-body warning">Set the tooth frame first.</div>;
  const margin = tooth.margin;
  const drafting = anchors.length > 0;

  return (
    <div className="step-body">
      <p className="hint-box">
        {drafting
          ? anchors.length < 3
            ? 'Keep clicking along the margin. The path follows the margin ridge between clicks.'
            : 'Click the first point (or press Enter) to close the margin.'
          : margin
            ? 'Drag a point to adjust the margin, or click on the prep to start drawing it again.'
            : 'Click on the margin to place the first point, then work around the prep.'}
      </p>
      {surface === 'analysing' && (
        <div className="row muted">
          <span className="spinner" /> Analysing the surface (curvature)…
        </div>
      )}
      {drafting && (
        <div className="row">
          <span className="muted">{anchors.length} points</span>
          <button className="btn" onClick={() => marginTool.undoAnchor()} title="Remove the last point (Backspace)">
            Undo point
          </button>
          <button className="btn primary" disabled={anchors.length < 3} onClick={() => void marginTool.close()} title="Close the loop (Enter)">
            Close
          </button>
          <button className="btn ghost" onClick={() => marginTool.cancel()} title="Discard (Esc)">
            Cancel
          </button>
        </div>
      )}
      {margin && !drafting && (
        <>
          <dl className="params">
            <dt>Length</dt>
            <dd>{polylineLength(margin.points).toFixed(1)} mm</dd>
            <dt>Control points</dt>
            <dd>{margin.anchors.length}</dd>
          </dl>
          <div className="row">
            <button className="btn" onClick={() => void marginTool.smooth()}>
              Smooth
            </button>
          </div>
        </>
      )}
      <p className="muted small">Backspace removes the last point · Esc cancels · Ctrl/⌘+Z undoes accepted edits</p>
    </div>
  );
}
