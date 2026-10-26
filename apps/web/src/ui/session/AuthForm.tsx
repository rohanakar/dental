import { useState } from 'react';
import { BASE_URL } from '../../io/urls';
import { goOffline, signIn, signUp, startDemo, useSessionStore } from '../../state/session';

export function AuthForm() {
  const [mode, setMode] = useState(() => useSessionStore.getState().authMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const busy = useSessionStore((s) => s.authBusy);
  const error = useSessionStore((s) => s.authError);
  const notice = useSessionStore((s) => s.notice);
  const signingUp = mode === 'sign-up';

  return (
    <div className="session-screen">
      <div className="session-card">
        <h1>Dental CAD</h1>
        {notice && <div className="notice">{notice}</div>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (signingUp ? signUp(email, password, name) : signIn(email, password));
          }}
        >
          <h2>{signingUp ? 'Create account' : 'Sign in'}</h2>
          {signingUp && (
            <div className="field">
              <label htmlFor="auth-name">Name</label>
              <input id="auth-name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          )}
          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              minLength={signingUp ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {signingUp && <span className="muted">At least 10 characters</span>}
          </div>
          {error && <div className="error">{error}</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Please wait…' : signingUp ? 'Create account' : 'Sign in'}
            </button>
            <button type="button" className="link-btn" onClick={() => setMode(signingUp ? 'sign-in' : 'sign-up')}>
              {signingUp ? 'I have an account' : 'Create an account'}
            </button>
          </div>
        </form>
        <hr className="divider" />
        <h2>No account needed</h2>
        <ul className="session-options">
          <li>
            <button className="btn" type="button" onClick={() => void startDemo()}>
              Try the demo case
            </button>
            <span className="muted">Ready-made scans: one click to a crown.</span>
          </li>
          <li>
            <button className="btn" type="button" onClick={goOffline}>
              Continue offline
            </button>
            <span className="muted">An empty case for your own scans. Nothing is saved.</span>
          </li>
        </ul>
      </div>
      <a className="session-back" href={BASE_URL}>
        What is this? See the product page
      </a>
    </div>
  );
}
