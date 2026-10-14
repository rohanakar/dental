import { adaptationStale } from '../../design/adaptation';
import { selectActiveTooth, useDesignStore } from '../../design/store';
import { reAdapt } from '../../tools/nudge';
import { useToolStore } from '../../tools/toolStore';

/**
 * Shown when a move or edit switched the stored adaptation off: the crown on
 * screen is the moved template without the occlusion and contact fit.
 */
export function ReadaptNotice() {
  const tooth = useDesignStore(selectActiveTooth);
  if (!tooth || !adaptationStale(tooth)) return null;
  return (
    <div className="warning readapt" role="status">
      <span>Adaptation is off since the last change; the crown is shown as moved, without the occlusion and contact fit.</span>
      <button className="btn primary" onClick={reAdapt}>
        Re-adapt
      </button>
    </div>
  );
}

/** Focus view while adjusting the crown: the prep stays bright, the gums, neighbours and antagonist are dimmed. */
export function FocusControls() {
  const focus = useToolStore((s) => s.focusPrep);
  const surroundings = useToolStore((s) => s.surroundings);
  const set = useToolStore((s) => s.set);
  return (
    <>
      <label className="row muted" title="Dim the gums, the neighbours and the antagonist; keep the prepared tooth bright">
        <input type="checkbox" checked={focus} onChange={(e) => set({ focusPrep: e.target.checked })} />
        Focus on the prep
      </label>
      <div className="row">
        <span className="muted">Surroundings</span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={surroundings}
          disabled={!focus}
          aria-label="Surroundings opacity"
          onChange={(e) => set({ surroundings: Number(e.target.value) })}
        />
      </div>
    </>
  );
}
