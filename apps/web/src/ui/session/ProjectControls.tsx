import { useRef } from 'react';
import { downloadProject, openProject, useSessionStore } from '../../state/session';

/** Toolbar buttons for local project files (`.dcad.zip`): works with and without the backend. */
export function ProjectControls() {
  const busy = useSessionStore((s) => s.projectBusy);
  const error = useSessionStore((s) => s.projectError);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="group" role="group" aria-label="Project file">
      <button
        className="btn quiet"
        type="button"
        title="Download the design and its scans as one .dcad.zip file"
        disabled={busy}
        onClick={() => void downloadProject()}
      >
        {busy ? 'Working…' : 'Download project'}
      </button>
      <button
        className="btn quiet"
        type="button"
        title="Open a .dcad.zip project (works offline)"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        Open project
      </button>
      <input
        ref={input}
        type="file"
        accept=".zip,.dcad.zip"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void openProject(file);
        }}
      />
      {error && (
        <span className="save-state failed" role="alert" title={error}>
          Project failed: {error}
        </span>
      )}
    </div>
  );
}
