import { unitKind } from '@dcad/shared';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { marginTool } from '../../tools/marginTool';
import { useToolStore } from '../../tools/toolStore';
import { NeedsFirst } from '../StepFooter';
import { isWing } from '../../tools/wing';
import { isCavity } from '../../tools/inlay';

/** The Margin step's hint for a Maryland wing's outline. */
function wingOutlineHint(drafting: boolean, anchors: number, drawn: boolean): string {
  if (drafting) return anchors < 3 ? 'Keep clicking around the wing area.' : 'Click the first point (or press Enter) to close the outline.';
  if (drawn) return 'Drag a point to adjust the outline, or click on the tooth to start drawing it again.';
  return 'Click around the area the wing covers on the lingual surface: 0.5 mm above the gingiva, 1 mm below the incisal edge, wrapping onto the side facing the pontic.';
}
/** The Margin step's hint for an inlay's or onlay's cavity margin. */
function cavityMarginHint(drafting: boolean, anchors: number, drawn: boolean): string {
  if (drafting) return anchors < 3 ? 'Keep clicking along the cavosurface edge, around the occlusal outline and each proximal box.' : 'Click the first point (or press Enter) to close the margin.';
  if (drawn) return 'Drag a point to adjust the cavity margin, or click on the tooth to start drawing it again.';
  return 'Click on the cavosurface edge of the cavity to place the first point, then work around the occlusal outline and the proximal boxes.';
}
import { ImplantPositionPanel, useIsImplant } from './ImplantPanel';
import { GumLineDoubt, MarginWarning } from './MarginIssues';

function polylineLength(points: ReadonlyArray<{ p: readonly number[] }>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!.p;
    const b = points[(i + 1) % points.length]!.p;
    sum += Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  }
  return sum;
}

/**
 * Which line the margin follows (specs/2026-10-27-natural-margin.md): a prepared tooth's finish line or a natural
 * tooth's gum line. It sets the live-wire for drawing and editing, and what Find (and auto-design) looks for.
 */
function MarginLineChoice({ fdi, line }: { fdi: number; line: 'finish' | 'gum' }) {
  const choose = (next: 'finish' | 'gum') => {
    marginTool.cancel();
    useToolStore.getState().set({ marginLine: { ...useToolStore.getState().marginLine, [fdi]: next } });
  };
  return (
    <div className="margin-line">
      <div className="seg" role="group" aria-label="The line the margin follows">
        <button className="btn" aria-pressed={line === 'finish'} onClick={() => choose('finish')} title="A prepared tooth: the edge the dentist cut">
          Finish line
        </button>
        <button className="btn" aria-pressed={line === 'gum'} onClick={() => choose('gum')} title="A natural (unprepared) tooth: where the tooth meets the gum">
          Gum line
        </button>
      </div>
      <span className="muted small">{line === 'gum' ? 'Natural tooth: where the tooth meets the gum.' : 'Prepared tooth: the edge the dentist cut.'}</span>
    </div>
  );
}

export function MarginStep() {
  const tooth = useDesignStore(selectActiveTooth);
  const pontic = useDesignStore((s) => unitKind(s.doc.setup, s.activeFdi) === 'pontic');
  const anchors = useToolStore((s) => s.marginAnchors);
  const section = useToolStore((s) => s.sectionRedraw);
  const choice = useToolStore((s) => (tooth ? s.marginLine[tooth.fdi] : undefined));
  const busy = useToolStore((s) => s.busy);
  const wing = useDesignStore((s) => isWing(s.doc.setup, s.activeFdi));
  const cavity = useDesignStore((s) => isCavity(s.doc.setup, s.activeFdi));
  const surface = useToolStore((s) => s.surface);
  const implant = useIsImplant();
  if (!tooth) return null;
  if (implant) return <ImplantPositionPanel />;
  if (pontic) return <div className="step-body muted">Pontic {tooth.fdi} replaces a missing tooth: it has no prep, so no margin.</div>;
  if (!tooth.frame) return <NeedsFirst>Set the tooth frame first.</NeedsFirst>;
  const margin = tooth.margin;
  const drafting = anchors.length > 0;
  // A crown on a natural or prepared tooth: the choice of line, Find, and Redraw a section.
  const crownLine = !wing && !cavity;
  const line = choice ?? margin?.line ?? 'finish';
  const findLabel = choice || margin?.line === 'gum' ? (line === 'gum' ? 'Find the gum line' : 'Find the finish line') : 'Find the margin';

  return (
    <div className="step-body">
      {crownLine && !drafting && !section && <MarginLineChoice fdi={tooth.fdi} line={line} />}
      <p className="hint-box">
        {wing
          ? wingOutlineHint(drafting, anchors.length, Boolean(margin))
          : cavity
          ? cavityMarginHint(drafting, anchors.length, Boolean(margin))
          : section
          ? section.first
            ? 'Now click where the wrong part ends. The path between follows the line; the rest is kept.'
            : 'Click on the line where the wrong part starts.'
          : drafting
          ? anchors.length < 3
            ? `Keep clicking along the margin. The path follows the ${line === 'gum' ? 'gum line' : 'margin ridge'} between clicks.`
            : 'Click the first point (or press Enter) to close the margin.'
          : margin
            ? 'Drag a point to adjust the margin, redraw a section, or click on the tooth to start drawing it again.'
            : `Find the ${line === 'gum' ? 'gum line' : 'margin'} automatically, or click on it to place the first point and work around the tooth.`}
      </p>
      {crownLine && !drafting && !section && (
        <div className="row">
          <button className={margin ? 'btn' : 'btn primary'} disabled={Boolean(busy)} onClick={() => void marginTool.find()}>
            {findLabel}
          </button>
        </div>
      )}
      {section && (
        <div className="row">
          <button className="btn ghost" onClick={() => marginTool.cancel()} title="Cancel (Esc)">
            Cancel
          </button>
        </div>
      )}
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
      {margin && !drafting && !section && (
        <>
          <MarginWarning fdi={tooth.fdi} />
          <GumLineDoubt fdi={tooth.fdi} />
          <dl className="params">
            <dt>Length</dt>
            <dd>{polylineLength(margin.points).toFixed(1)} mm</dd>
          </dl>
          <div className="row">
            <button className="btn" onClick={() => marginTool.startSection()} title="Two clicks: where the wrong part starts and where it ends">
              Redraw a section
            </button>
            <button className="btn" onClick={() => void marginTool.smooth()}>
              Smooth
            </button>
          </div>
        </>
      )}
      {drafting && <p className="muted small">Backspace removes the last point · Esc cancels</p>}
    </div>
  );
}
