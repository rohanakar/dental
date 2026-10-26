import type { ReactNode } from 'react';
import { BASE_URL } from '../../io/urls';

/**
 * The frame of every screen before the editor: the landing page's bar with the wordmark (back to the product page)
 * and, on the right, what belongs to the screen (the signed-in user, sign out).
 */
export function SessionPage({ children, aside, className = '' }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className="session-screen">
      <header className="session-nav">
        <a className="session-wordmark" href={BASE_URL} aria-label="Dental CAD, product page">
          Dental CAD
        </a>
        {aside && <div className="session-nav-aside">{aside}</div>}
      </header>
      <main className={`session-main ${className}`}>{children}</main>
    </div>
  );
}
