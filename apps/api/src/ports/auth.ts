/** Who is calling, resolved from the request by the auth adapter. */
export interface AuthContext {
  userId: string;
  orgId: string;
  role: string;
}

export interface AuthPort {
  /** Handles the auth provider's own HTTP endpoints (sign-up, sign-in, ...). */
  handler(request: Request): Promise<Response>;
  /**
   * Resolve the caller from request headers. Returns null when there is no
   * valid session; `{ userId, orgId: null }` when signed in without an org.
   */
  resolve(headers: Headers): Promise<AuthContext | { userId: string; orgId: null } | null>;
}
