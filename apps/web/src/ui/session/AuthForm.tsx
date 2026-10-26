import { useState } from 'react';
import heroRender from '../../landing/assets/hero-crown.webp';
import { goOffline, signIn, signUp, startDemo, useSessionStore } from '../../state/session';
import { SessionPage } from './SessionPage';

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
    <SessionPage className="auth">
      <div className="auth-copy">
        <h1>{signingUp ? 'Create your lab account' : 'Sign in to your lab'}</h1>
        {notice && <div className="notice">{notice}</div>}
        <form
          className="auth-form"
          aria-label={signingUp ? 'Create account' : 'Sign in'}
          onSubmit={(e) => {
            e.preventDefault();
            void (signingUp ? signUp(email, password, name) : signIn(email, password));
          }}
        >
          {signingUp && (
            <div className="field">
              <label htmlFor="auth-name">Name</label>
              <input id="auth-name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          )}
          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" type="email" autoComplete="email" placeholder="you@yourlab.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="auth-password">
              Password{signingUp && <span className="label-hint"> (10+ characters)</span>}
            </label>
            <input
              id="auth-password"
              type="password"
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              minLength={signingUp ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Please wait…' : signingUp ? 'Create account' : 'Sign in'}
            </button>
            <button type="button" className="link-btn" onClick={() => setMode(signingUp ? 'sign-in' : 'sign-up')}>
              {signingUp ? 'I have an account' : 'Create an account'}
            </button>
          </div>
        </form>
        <section className="no-account" aria-labelledby="no-account-head">
          <h2 id="no-account-head">No account needed</h2>
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
        </section>
      </div>
      <figure className="auth-shot">
        <img src={heroRender} width="1400" height="1326" alt="A crown proposed on the synthetic demo prep of tooth 36, with its occlusion map" />
        <figcaption>The demo case: tooth 36, one click to this crown.</figcaption>
      </figure>
    </SessionPage>
  );
}
