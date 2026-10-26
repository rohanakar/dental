import { useEffect, type ReactNode } from 'react';
import { enter, useSessionStore } from '../../state/session';
import { AuthForm } from './AuthForm';
import { CaseList } from './CaseList';
import { SessionPage } from './SessionPage';
import './session.css';
import './journey.css';

/**
 * Shows sign-in or the case list until a case is open (or the user chose to
 * work offline or opened the demo), then renders the editor (`children`).
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const status = useSessionStore((s) => s.status);

  useEffect(() => {
    void enter();
  }, []);

  switch (status) {
    case 'checking':
      return (
        <SessionPage>
          <div className="row muted">
            <span className="spinner" /> Connecting…
          </div>
        </SessionPage>
      );
    case 'signed-out':
      return <AuthForm />;
    case 'cases':
      return <CaseList />;
    case 'editor':
      return <>{children}</>;
  }
}
