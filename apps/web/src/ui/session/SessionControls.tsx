import { useEffect } from 'react';
import { selectDirty, useDesignStore } from '../../design/store';
import { backToCases, save, signOut, useSessionStore } from '../../state/session';
import { AlertIcon } from '../icons';
import './session.css';

function SaveState() {
  const dirty = useDesignStore(selectDirty);
  const version = useDesignStore((s) => s.version);
  const saving = useSessionStore((s) => s.saving);
  const error = useSessionStore((s) => s.saveError);
  if (saving)
    return (
      <span className="save-state" role="status">
        Saving…
      </span>
    );
  if (error)
    return (
      <span className="save-state failed" role="alert" title={error}>
        Save failed: {error}
      </span>
    );
  if (dirty) return <span className="save-state dirty">Unsaved changes</span>;
  return <span className="save-state">{version > 0 ? `Saved v${version}` : 'Not saved yet'}</span>;
}

/** Right side of the toolbar: case label, save state, Save, Cases, Sign out. */
export function SessionControls() {
  const offline = useSessionStore((s) => s.offline);
  const user = useSessionStore((s) => s.user);
  const currentCase = useSessionStore((s) => s.currentCase);
  const saving = useSessionStore((s) => s.saving);
  const saveError = useSessionStore((s) => s.saveError);
  const saveWarning = useSessionStore((s) => s.saveWarning);
  const dirty = useDesignStore(selectDirty);
  const canSave = Boolean(currentCase) && dirty && !saving;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (useSessionStore.getState().currentCase) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (offline) {
    return (
      <div className="session-controls">
        <span className="badge offline" title="Nothing is saved in offline mode">
          Offline
        </span>
        <button className="btn" type="button" onClick={backToCases}>
          {user ? 'Cases' : 'Sign in'}
        </button>
      </div>
    );
  }

  const label = currentCase
    ? `${currentCase.patientRef || 'Case'} · ${currentCase.teeth.join(', ')}`
    : 'No case';
  return (
    <div className="session-controls">
      <span className="case-label" title={label}>
        {label}
      </span>
      <SaveState />
      {saveWarning && (
        <span className="badge offline" role="status" title={saveWarning}>
          <AlertIcon />
          Scans not saved
          <span className="visually-hidden">: {saveWarning}</span>
        </span>
      )}
      <button
        className="btn primary"
        type="button"
        disabled={!canSave}
        title={saveError ?? 'Save a new version (Ctrl/Cmd+S)'}
        onClick={() => void save()}
      >
        Save
      </button>
      <button className="btn quiet" type="button" onClick={backToCases}>
        Cases
      </button>
      <button className="btn quiet" type="button" title={user?.email} onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}
