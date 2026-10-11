import type { ClinicalAxis, ClinicalDirection } from '@dcad/shared';
import type { MouseEvent } from 'react';
import { useGizmoStore } from '../../tools/gizmoTool';
import { MOVE_MM, moveCrown, nudge, ROTATE_DEG, SCALE_PCT } from '../../tools/nudge';
import './NudgePad.css';

const MOVES: Array<ClinicalDirection | null> = [null, 'buccal', 'occlusal', 'mesial', null, 'distal', null, 'lingual', 'cervical'];
const AXES: Array<{ axis: ClinicalAxis; label: string }> = [
  { axis: 'mesial-distal', label: 'Mesial–distal' },
  { axis: 'buccal-lingual', label: 'Buccal–lingual' },
  { axis: 'occlusal', label: 'Occlusal' },
];

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * Clinical nudges for the crown: move in tooth-frame directions (Shift-click
 * = 0.5 mm), rotate about the clinical axes and scale along them. Every
 * button is one undoable command; the keyboard does the same moves
 * (←/→ mesial/distal, ↑/↓ buccal/lingual, PageUp/PageDown occlusal/cervical).
 */
export function NudgePad() {
  const gizmo = useGizmoStore((s) => s.enabled);
  const setGizmo = useGizmoStore((s) => s.setEnabled);
  const move = (direction: ClinicalDirection) => (e: MouseEvent) => moveCrown(direction, e.shiftKey);

  return (
    <div className="nudge-pad">
      <div className="nudge-label">
        Move {MOVE_MM.small} mm (Shift: {MOVE_MM.large} mm)
      </div>
      <div className="nudge-grid" role="group" aria-label="Move the crown">
        {MOVES.map((d, i) =>
          d ? (
            <button
              key={d}
              className="btn"
              aria-label={`Move crown ${MOVE_MM.small} mm ${d}`}
              title={`Move ${d} (Shift: ${MOVE_MM.large} mm)`}
              onClick={move(d)}
            >
              {cap(d)}
            </button>
          ) : (
            <span key={`gap-${i}`} />
          ),
        )}
      </div>
      <div className="nudge-label">
        Rotate ±{ROTATE_DEG}° · scale ±{SCALE_PCT}%
      </div>
      {AXES.map(({ axis, label }) => (
        <div className="nudge-row" key={axis}>
          <span>{label}</span>
          <span className="row">
            <button className="btn" aria-label={`Rotate crown ${ROTATE_DEG} degrees about the ${label} axis`} onClick={() => nudge({ kind: 'rotate', axis, deg: ROTATE_DEG })}>
              ↺
            </button>
            <button className="btn" aria-label={`Rotate crown −${ROTATE_DEG} degrees about the ${label} axis`} onClick={() => nudge({ kind: 'rotate', axis, deg: -ROTATE_DEG })}>
              ↻
            </button>
          </span>
          <span className="row">
            <button className="btn" aria-label={`Scale crown −${SCALE_PCT}% along ${label}`} onClick={() => nudge({ kind: 'scale', axis, pct: -SCALE_PCT })}>
              −
            </button>
            <button className="btn" aria-label={`Scale crown +${SCALE_PCT}% along ${label}`} onClick={() => nudge({ kind: 'scale', axis, pct: SCALE_PCT })}>
              +
            </button>
          </span>
        </div>
      ))}
      <label className="row muted">
        <input type="checkbox" checked={gizmo} onChange={(e) => setGizmo(e.target.checked)} />
        Gizmo (drag the arrows to move the crown)
      </label>
    </div>
  );
}
