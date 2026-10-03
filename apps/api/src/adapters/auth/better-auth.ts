import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { AuthPort } from '../../ports/auth';
import { member } from '../db/auth-schema';
import { schema, type Db } from '../db/client';
import { authPlugins } from './plugins';

export interface BetterAuthOptions {
  db: Db;
  secret: string;
  /** Public URL incl. optional sub-path, e.g. https://dental.cognifuze.com or https://example.com/dental */
  publicUrl: string;
  publicOrigin: string;
  /** '' at the root, else e.g. '/dental'. The reverse proxy strips it before requests reach the API. */
  basePath: string;
  /** Extra allowed origins (e.g. the Vite dev server). */
  trustedOrigins: string[];
  production: boolean;
}

function slugFor(userId: string): string {
  return `lab-${userId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60);
}

/**
 * Better Auth with email/password and organizations, storing everything in
 * our own Postgres (auth tables live in the same Drizzle schema/migrations).
 * Swapping to an external OIDC provider means replacing this adapter only.
 */
export function createBetterAuth(options: BetterAuthOptions) {
  const { db } = options;

  const firstMembership = async (userId: string) => {
    const [row] = await db
      .select({ organizationId: member.organizationId, role: member.role })
      .from(member)
      .where(eq(member.userId, userId))
      .orderBy(asc(member.createdAt))
      .limit(1);
    return row ?? null;
  };

  const auth = betterAuth({
    secret: options.secret,
    // Better Auth ignores `basePath` when baseURL already has a path, and routes on
    // baseURL's pathname. Give it the full public auth URL so generated links are
    // public URLs; handler() re-adds the stripped sub-path before routing.
    baseURL: `${options.publicUrl}/api/auth`,
    basePath: '/api/auth',
    trustedOrigins: [options.publicOrigin, ...options.trustedOrigins],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    plugins: authPlugins(),
    telemetry: { enabled: false },
    advanced: {
      useSecureCookies: options.production && options.publicUrl.startsWith('https://'),
      defaultCookieAttributes: { path: options.basePath || '/' },
    },
    databaseHooks: {
      user: {
        create: {
          // Every user gets a personal lab (organization) so all data is org-scoped from day one.
          after: async (user) => {
            await auth.api.createOrganization({
              body: { name: `${user.name || user.email}'s lab`, slug: slugFor(user.id), userId: user.id },
            });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (session.activeOrganizationId) return;
            const membership = await firstMembership(session.userId);
            if (!membership) return;
            return { data: { ...session, activeOrganizationId: membership.organizationId } };
          },
        },
      },
    },
  });

  const port: AuthPort = {
    handler(request) {
      if (!options.basePath) return auth.handler(request);
      const url = new URL(request.url);
      url.pathname = `${options.basePath}${url.pathname}`;
      const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers: request.headers };
      if (request.body) {
        init.body = request.body;
        init.duplex = 'half';
      }
      return auth.handler(new Request(url, init));
    },
    async resolve(headers) {
      const result = await auth.api.getSession({ headers });
      if (!result) return null;
      const userId = result.user.id;
      const activeOrgId = (result.session as { activeOrganizationId?: string | null }).activeOrganizationId;
      if (activeOrgId) {
        // Re-check membership: the session's active org may be stale after removal from an org.
        const [match] = await db
          .select({ role: member.role })
          .from(member)
          .where(and(eq(member.userId, userId), eq(member.organizationId, activeOrgId)));
        if (match) return { userId, orgId: activeOrgId, role: match.role };
      }
      // No (valid) active org on the session: fall back to the user's first membership.
      const membership = await firstMembership(userId);
      if (!membership) return { userId, orgId: null };
      return { userId, orgId: membership.organizationId, role: membership.role };
    },
  };

  return { auth, port };
}
