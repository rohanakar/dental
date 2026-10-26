import { unitKind } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { marginTool } from '../../tools/marginTool';
import { useToolStore } from '../../tools/toolStore';
import { isWing } from '../../tools/wing';

/** The Margin step's hint for a Maryland wing's outline. */
function wingOutlineHint(drafting: boolean, anchors: number, drawn: boolean): string {
  if (drafting) return anchors < 3 ? 'Keep clicking around the wing area.' : 'Click the first point (or press Enter) to close the outline.';
  if (drawn) return 'Drag a point to adjust the outline, or click on the tooth to start drawing it again.';
  return 'Click around the area the wing covers on the lingual surface: 0.5 mm above the gingiva, 1 mm below the incisal edge, wrapping onto the side facing the pontic.';
}
import { ImplantPositionPanel, useIsImplant } from './ImplantPanel';
import { MarginWarning } from './MarginIssues';

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
  const pontic = useDesignStore((s) => unitKind(s.doc.setup, s.activeFdi) === 'pontic');
  const anchors = useToolStore((s) => s.marginAnchors);
  const wing = useDesignStore((s) => isWing(s.doc.setup, s.activeFdi));
  const surface = useToolStore((s) => s.surface);
  const implant = useIsImplant();
  if (!tooth) return null;
  if (implant) return <ImplantPositionPanel />;
  if (pontic) return <div className="step-body muted">Pontic {tooth.fdi} replaces a missing tooth: it has no prep, so no margin.</div>;
  if (!tooth.frame) return <div className="step-body warning">Set the tooth frame first.</div>;
  const margin = tooth.margin;
  const drafting = anchors.length > 0;

  return (
    <div className="step-body">
      <p className="hint-box">
        {wing
          ? wingOutlineHint(drafting, anchors.length, Boolean(margin))
          : drafting
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
          <MarginWarning fdi={tooth.fdi} />
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
