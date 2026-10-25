import type { ClinicalAxis, ClinicalDirection } from '@dcad/shared';
import type { MouseEvent } from 'react';
import { useGizmoStore } from '../../tools/gizmoTool';
import { MOVE_MM, moveCrown, nudge, ROTATE_DEG, SCALE_PCT } from '../../tools/nudge';
import { RotateLeftIcon, RotateRightIcon } from '../icons';
import { ReadaptNotice } from './CrownViewControls';
import './NudgePad.css';

/** A cross for the tooth-plane directions (like the axis tilt pad), and occlusal / cervical in their own column. */
const MOVES: Array<ClinicalDirection | null> = [null, 'buccal', null, 'occlusal', 'mesial', null, 'distal', null, null, 'lingual', null, 'cervical'];
const KEYS: Record<ClinicalDirection, { label: string; key: string }> = {
  mesial: { label: '←', key: 'ArrowLeft' },
  distal: { label: '→', key: 'ArrowRight' },
  buccal: { label: '↑', key: 'ArrowUp' },
  lingual: { label: '↓', key: 'ArrowDown' },
  occlusal: { label: 'PgUp', key: 'PageUp' },
  cervical: { label: 'PgDn', key: 'PageDown' },
};
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
 * A move shifts the anatomy while the margin stays on the prep, and switches
 * a stored adaptation off until Re-adapt.
 */
export function NudgePad() {
  const gizmo = useGizmoStore((s) => s.enabled);
  const setGizmo = useGizmoStore((s) => s.setEnabled);
  const move = (direction: ClinicalDirection) => (e: MouseEvent) => moveCrown(direction, e.shiftKey);

  return (
    <div className="nudge-pad">
      <ReadaptNotice />
      <h3>Adjust</h3>
      <div className="nudge-label">
        Move {MOVE_MM.small} mm, or {MOVE_MM.large} mm with Shift. The cusps follow; the margin stays on the prep. Keys: arrows
        and PgUp/PgDn.
      </div>
      <div className="nudge-grid" role="group" aria-label="Move the crown">
        {MOVES.map((d, i) =>
          d ? (
            <button
              key={d}
              className="btn"
              aria-label={`Move crown ${MOVE_MM.small} mm ${d}`}
              aria-keyshortcuts={KEYS[d].key}
              title={`Move ${d} (${KEYS[d].label}; Shift: ${MOVE_MM.large} mm)`}
              onClick={move(d)}
            >
              {cap(d)}
            </button>
          ) : (
            <span key={`gap-${i}`} />
          ),
        )}
      </div>
      <div className="nudge-row nudge-head">
        <span />
        <span>Rotate ±{ROTATE_DEG}°</span>
        <span>Scale ±{SCALE_PCT}%</span>
      </div>
      {AXES.map(({ axis, label }) => (
        <div className="nudge-row" key={axis}>
          <span>{label}</span>
          <span className="row">
            <button className="btn" aria-label={`Rotate crown ${ROTATE_DEG} degrees about the ${label} axis`} onClick={() => nudge({ kind: 'rotate', axis, deg: ROTATE_DEG })}>
              <RotateLeftIcon />
            </button>
            <button className="btn" aria-label={`Rotate crown −${ROTATE_DEG} degrees about the ${label} axis`} onClick={() => nudge({ kind: 'rotate', axis, deg: -ROTATE_DEG })}>
              <RotateRightIcon />
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
