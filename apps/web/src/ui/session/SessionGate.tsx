import { useEffect, type ReactNode } from 'react';
import { init, useSessionStore } from '../../state/session';
import { AuthForm } from './AuthForm';
import { CaseList } from './CaseList';
import './session.css';

/**
 * Shows sign-in or the case list until a case is open (or the user chose to
 * work offline), then renders the editor (`children`).
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const status = useSessionStore((s) => s.status);

  useEffect(() => {
    void init();
  }, []);

  switch (status) {
    case 'checking':
      return (
        <div className="session-screen">
          <div className="row muted">
            <span className="spinner" /> Connecting…
          </div>
        </div>
      );
    case 'signed-out':
      return <AuthForm />;
    case 'cases':
      return <CaseList />;
    case 'editor':
      return <>{children}</>;
  }
}
