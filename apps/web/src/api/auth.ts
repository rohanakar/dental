import { createAuthClient } from 'better-auth/client';
import { apiUrl } from '../io/urls';

/**
 * Better Auth client (email + password). The auth endpoints live under the
 * API at /api/auth, behind any sub-path the app is mounted on.
 */
let client: ReturnType<typeof createAuthClient> | null = null;
function authClient() {
  client ??= createAuthClient({ baseURL: new URL(apiUrl('auth'), window.location.origin).href });
  return client;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

type Result<T> = { data: T | null; error: { message?: string; status: number; statusText?: string } | null };

function unwrap<T>(result: Result<T>, fallback: string): T {
  if (result.error) throw new AuthError(result.error.message || result.error.statusText || fallback, result.error.status);
  if (result.data === null) throw new AuthError(fallback, 500);
  return result.data;
}

const toUser = (u: { id: string; email: string; name: string }): AuthUser => ({ id: u.id, email: u.email, name: u.name });

export async function signUp(email: string, password: string, name: string): Promise<AuthUser> {
  const data = unwrap(await authClient().signUp.email({ email, password, name }), 'Could not create the account');
  return toUser(data.user);
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const data = unwrap(await authClient().signIn.email({ email, password }), 'Could not sign in');
  return toUser(data.user);
}

export async function signOut(): Promise<void> {
  const result = await authClient().signOut();
  if (result.error) throw new AuthError(result.error.message || 'Could not sign out', result.error.status);
}

/** The signed-in user, or null without a session. */
export async function getSession(): Promise<AuthUser | null> {
  const result = await authClient().getSession();
  if (result.error) throw new AuthError(result.error.message || 'Could not read the session', result.error.status);
  return result.data ? toUser(result.data.user) : null;
}
