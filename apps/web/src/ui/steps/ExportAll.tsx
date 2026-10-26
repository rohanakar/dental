import { type DesignDocument } from '@dcad/shared';
import { useEffect, useRef, useState } from 'react';
import { useDesignStore } from '../../design/store';
import { downloadBytes } from '../../io/exportCrown';
import { markExported } from '../../state/exported';
import { useSessionStore } from '../../state/session';
import { errorText } from '../../tools/context';
import { CheckIcon } from '../icons';
import { type ExportAll as ExportAllResult, exportAll, restorationsOf } from './restorations';
import './ExportAll.css';

type State =
  | { phase: 'idle' }
  | { phase: 'designing' }
  | { phase: 'confirm'; result: ExportAllResult; doc: DesignDocument }
  | { phase: 'done'; file: string; at: string; open: number }
  | { phase: 'error'; message: string };

const time = () => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Finalize: every restoration of the case in one download (a zip with each STL, its construction sidecar and a
 * manifest of open checks). Each restoration is designed from the current document, not only the active one. The
 * soft gate of the single export applies: with open checks the zip is offered as "Export all anyway" after a list of
 * them. Shown when the case has two or more restorations.
 */
export function ExportAll() {
  const doc = useDesignStore((s) => s.doc);
  const sessionRef = useSessionStore((s) => s.currentCase?.patientRef);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const run = useRef(0);
  const restorations = restorationsOf(doc);

  // A prepared zip belongs to the document it was designed from.
  useEffect(() => {
    if (state.phase === 'confirm' && state.doc !== doc) setState({ phase: 'idle' });
  }, [doc, state]);

  if (restorations.length < 2) return null;

  const download = (result: ExportAllResult) => {
    downloadBytes(result.zip.bytes, result.zip.fileName, 'application/zip');
    markExported(result.restorations.filter((r) => !r.skipped).flatMap((r) => r.teeth), result.zip.fileName);
    setState({ phase: 'done', file: result.zip.fileName, at: time(), open: result.restorations.filter((r) => r.skipped || r.open.length > 0).length });
  };

  const start = async () => {
    const id = ++run.current;
    const designed = doc;
    setState({ phase: 'designing' });
    try {
      const result = await exportAll(designed, sessionRef);
      if (id !== run.current) return;
      if (result.ready) download(result);
      else setState({ phase: 'confirm', result, doc: designed });
    } catch (e) {
      if (id === run.current) setState({ phase: 'error', message: errorText(e) });
    }
  };

  const names = restorations.map((r) => r.name).join(', ');
  return (
    <section className="export-all" aria-labelledby="export-all-head">
      <h3 id="export-all-head">All restorations</h3>
      <p className="muted">
        {names} in one zip: each STL with its construction info, and a manifest of the checks still open.
      </p>
      {state.phase === 'confirm' ? (
        <div className="confirm-box" role="alert">
          <strong>Export all with open checks?</strong>
          <ul>
            {state.result.restorations
              .filter((r) => r.skipped || r.open.length > 0)
              .map((r) => (
                <li key={r.base}>
                  {r.name}:{' '}
                  {r.skipped
                    ? `left out. ${r.skipped}`
                    : `${r.open.length} open: ${r.open.map((c) => c.label).join('; ')}`}
                </li>
              ))}
          </ul>
          <div className="row">
            <button className="btn primary" onClick={() => download(state.result)}>
              Export all anyway
            </button>
            <button className="btn" onClick={() => setState({ phase: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn" disabled={state.phase === 'designing'} onClick={() => void start()}>
            {state.phase === 'designing' ? (
              <>
                <span className="spinner" /> Designing {restorations.length} restorations…
              </>
            ) : (
              'Export all (zip)'
            )}
          </button>
        </div>
      )}
      {state.phase === 'done' && (
        <div className="export-done" role="status">
          <CheckIcon /> Exported {state.file} at {state.at}
          {state.open > 0 ? `, ${state.open} with open checks (listed in its README)` : ''}
        </div>
      )}
      {state.phase === 'error' && (
        <div className="error" role="alert">
          Export all failed: {state.message}
        </div>
      )}
    </section>
  );
}
