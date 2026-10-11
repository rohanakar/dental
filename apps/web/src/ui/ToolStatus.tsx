import { useToolStore } from '../tools/toolStore';

/** Busy indicator and the latest tool message for the active step. */
export function ToolStatus() {
  const busy = useToolStore((s) => s.busy);
  const message = useToolStore((s) => s.message);
  return (
    <>
      {busy && (
        <div className="row muted" role="status">
          <span className="spinner" /> {busy}
        </div>
      )}
      {message && (
        <div className={message.kind === 'error' ? 'error' : message.kind === 'warning' ? 'warning' : 'info'} role="status">
          {message.text}
        </div>
      )}
    </>
  );
}
