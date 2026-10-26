import type { CaseSummary } from '@dcad/shared';
import { goOffline, openCase, refreshCases, signOut, startDemo, useSessionStore } from '../../state/session';
import { NewCaseForm } from './NewCaseForm';
import { SessionPage } from './SessionPage';

const STATUS_LABEL: Record<CaseSummary['status'], string> = {
  draft: 'Draft',
  'in-design': 'In design',
  done: 'Done',
};

const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function CaseList() {
  const user = useSessionStore((s) => s.user);
  const cases = useSessionStore((s) => s.cases);
  const loading = useSessionStore((s) => s.casesLoading);
  const error = useSessionStore((s) => s.casesError);
  const opening = useSessionStore((s) => s.opening);
  const openError = useSessionStore((s) => s.openError);

  return (
    <SessionPage
      className="cases"
      aside={
        <>
          {user && <span className="muted">{user.email}</span>}
          <button className="btn" type="button" onClick={goOffline} title="Work locally; nothing is saved">
            Work offline
          </button>
          <button className="btn" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </>
      }
    >
      <h1>Cases</h1>
      <section className="new-case-panel" aria-labelledby="new-case-head">
        <h2 id="new-case-head">New case</h2>
        <NewCaseForm />
        {openError && <div className="error">{openError}</div>}
      </section>

      <div className="session-head">
        <h2>Your lab's cases</h2>
        <span className="spacer" />
        <button className="btn ghost" type="button" onClick={() => void refreshCases()} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {loading && cases.length === 0 && (
        <div className="row muted">
          <span className="spinner" /> Loading cases…
        </div>
      )}
      {!loading && !error && cases.length === 0 && (
        <div className="first-run">
          <p>
            <strong>No cases yet.</strong> A case is one order: the tooth, the material and the scans. Create it above,
            then import the scans.
          </p>
          <p className="muted">
            You need the upper and lower jaw scans as STL or PLY, already in occlusion, with the prep in its jaw scan. Use
            a lab reference, never a patient name.
          </p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => void startDemo()}>
              Try the demo case first
            </button>
            <span className="muted">Synthetic scans of tooth 36. Nothing is saved.</span>
          </div>
        </div>
      )}
      {cases.length > 0 && (
        <div className="case-table-wrap">
          <table className="case-table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Teeth</th>
                <th>Status</th>
                <th>Version</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr
                  key={c.id}
                  tabIndex={0}
                  aria-disabled={opening}
                  onClick={() => !opening && void openCase(c.id)}
                  onKeyDown={(e) => e.key === 'Enter' && !opening && void openCase(c.id)}
                >
                  <td>{c.patientRef || <span className="muted">(no reference)</span>}</td>
                  <td>{c.teeth.join(', ')}</td>
                  <td>{STATUS_LABEL[c.status]}</td>
                  <td>{c.currentVersion > 0 ? `v${c.currentVersion}` : '—'}</td>
                  <td>{formatDate(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SessionPage>
  );
}
