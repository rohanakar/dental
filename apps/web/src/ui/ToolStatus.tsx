import { useEffect, useRef } from 'react';
import { useDesignStore } from '../design/store';
import { useToolStore } from '../tools/toolStore';
import { CloseIcon } from './icons';

/**
 * Busy indicator and the latest tool message, in the step footer so it is always in view. A new message replaces
 * the old one; a notice from an earlier step goes when the step changes, while warnings and errors stay until
 * dismissed or replaced.
 */
export function ToolStatus() {
  const busy = useToolStore((s) => s.busy);
  const message = useToolStore((s) => s.message);
  const step = useDesignStore((s) => s.activeStep);
  const shownOn = useRef(step);
  useEffect(() => {
    shownOn.current = step;
  }, [message]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = useToolStore.getState().message;
    if (m?.kind === 'info' && shownOn.current !== step) useToolStore.getState().set({ message: null });
  }, [step]);
  if (!busy && !message) return null;
  return (
    <div className="status-line">
      {busy && (
        <div className="status-busy" role="status">
          <span className="spinner" /> {busy}
        </div>
      )}
      {message && (
        <div className={`status-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          <span>{message.text}</span>
          <button type="button" className="btn ghost icon status-dismiss" aria-label="Dismiss" onClick={() => useToolStore.getState().set({ message: null })}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
