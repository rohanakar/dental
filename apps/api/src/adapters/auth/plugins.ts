import { organization } from 'better-auth/plugins';

/**
 * Better Auth plugins. Shared by the runtime auth instance and by
 * scripts/gen-auth-schema.ts, so the generated Drizzle tables always match.
 */
export const authPlugins = () => [organization()];
