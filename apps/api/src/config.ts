import { z } from 'zod';
import type { LlmPurpose } from '@dcad/shared';

const LlmProviderName = z.enum(['anthropic', 'openai', 'mock']);
export type LlmProviderName = z.infer<typeof LlmProviderName>;

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().url(),
    MIGRATE_ON_START: bool.default(true),
    MIGRATIONS_DIR: z.string().optional(),

    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    /**
     * Public URL of the app (origin + optional sub-path), e.g. https://dental.cognifuze.com
     * or https://example.com/dental. The reverse proxy strips the sub-path, so the API
     * always serves /api/* internally.
     */
    PUBLIC_URL: z.string().url().default('http://localhost:8080'),
    /** Extra allowed origins (comma separated), e.g. the Vite dev server. */
    TRUSTED_ORIGINS: csv.default([]),

    BLOB_DRIVER: z.enum(['fs', 's3']).default('fs'),
    BLOB_FS_ROOT: z.string().default('./data/blobs'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool.default(true),

    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
    MAX_JSON_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().optional(),
    LLM_AGENT_PROVIDER: LlmProviderName.optional(),
    LLM_AGENT_MODEL: z.string().optional(),
    LLM_RX_PROVIDER: LlmProviderName.optional(),
    LLM_RX_MODEL: z.string().optional(),
    /** If set, every configured model must be in this list. */
    LLM_MODEL_ALLOWLIST: csv.optional(),
    LLM_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),
  })
  .superRefine((env, ctx) => {
    if (env.BLOB_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when BLOB_DRIVER=s3` });
      }
    }
  });

export interface LlmRoute {
  provider: LlmProviderName;
  model: string;
}

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  migrateOnStart: boolean;
  migrationsDir: string;
  /** Public URL without trailing slash, e.g. https://dental.cognifuze.com */
  publicUrl: string;
  /** Scheme + host of publicUrl. */
  publicOrigin: string;
  /** Sub-path the app is mounted under ('' at the root, else e.g. '/dental'). */
  basePath: string;
  auth: { secret: string; trustedOrigins: string[] };
  blob:
    | { driver: 'fs'; root: string }
    | {
        driver: 's3';
        endpoint?: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
        forcePathStyle: boolean;
      };
  limits: { maxUploadBytes: number; maxJsonBytes: number };
  llm: {
    anthropicApiKey?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    routes: Record<LlmPurpose, LlmRoute>;
    rateLimitPerMin: number;
    /** Human-readable notes about fallbacks, logged at startup. */
    warnings: string[];
  };
}

const DEFAULT_MODELS: Record<LlmProviderName, string | undefined> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  mock: 'mock-1',
};

function resolveRoute(
  purpose: LlmPurpose,
  requested: LlmProviderName | undefined,
  model: string | undefined,
  keys: { anthropic: boolean; openai: boolean },
  warnings: string[],
): LlmRoute {
  let provider: LlmProviderName =
    requested ?? (keys.anthropic ? 'anthropic' : keys.openai ? 'openai' : 'mock');
  if ((provider === 'anthropic' && !keys.anthropic) || (provider === 'openai' && !keys.openai)) {
    warnings.push(`LLM ${purpose}: provider "${provider}" has no API key; falling back to mock`);
    provider = 'mock';
  }
  if (provider === 'mock') return { provider, model: DEFAULT_MODELS.mock! };
  // Provider auto-selection can pick a provider the configured model doesn't belong to.
  const isClaude = (m: string) => /^claude-/.test(m);
  if (model && (provider === 'anthropic') !== isClaude(model)) {
    warnings.push(`LLM ${purpose}: model "${model}" does not look like a ${provider} model; using ${DEFAULT_MODELS[provider]}`);
    model = undefined;
  }
  return { provider, model: model ?? DEFAULT_MODELS[provider]! };
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  // Treat empty values (e.g. `OPENAI_API_KEY=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  const publicUrl = env.PUBLIC_URL.replace(/\/+$/, '');
  const parsedPublicUrl = new URL(publicUrl);
  const basePath = parsedPublicUrl.pathname.replace(/\/+$/, '');
  const keys = { anthropic: !!env.ANTHROPIC_API_KEY, openai: !!env.OPENAI_API_KEY };
  const warnings: string[] = [];
  const routes: Record<LlmPurpose, LlmRoute> = {
    agent: resolveRoute('agent', env.LLM_AGENT_PROVIDER, env.LLM_AGENT_MODEL, keys, warnings),
    'rx-intake': resolveRoute('rx-intake', env.LLM_RX_PROVIDER, env.LLM_RX_MODEL ?? env.LLM_AGENT_MODEL, keys, warnings),
  };
  if (env.LLM_MODEL_ALLOWLIST) {
    for (const [purpose, route] of Object.entries(routes)) {
      if (route.provider !== 'mock' && !env.LLM_MODEL_ALLOWLIST.includes(route.model)) {
        throw new Error(`LLM ${purpose}: model "${route.model}" is not in LLM_MODEL_ALLOWLIST`);
      }
    }
  }

  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    migrateOnStart: env.MIGRATE_ON_START,
    migrationsDir: env.MIGRATIONS_DIR ?? `${process.cwd()}/drizzle`,
    publicUrl,
    publicOrigin: parsedPublicUrl.origin,
    basePath,
    auth: {
      secret: env.AUTH_SECRET,
      trustedOrigins: env.TRUSTED_ORIGINS,
    },
    blob:
      env.BLOB_DRIVER === 's3'
        ? {
            driver: 's3',
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION,
            bucket: env.S3_BUCKET!,
            accessKeyId: env.S3_ACCESS_KEY_ID!,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
          }
        : { driver: 'fs', root: env.BLOB_FS_ROOT },
    limits: { maxUploadBytes: env.MAX_UPLOAD_BYTES, maxJsonBytes: env.MAX_JSON_BYTES },
    llm: {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      openaiApiKey: env.OPENAI_API_KEY,
      openaiBaseUrl: env.OPENAI_BASE_URL,
      routes,
      rateLimitPerMin: env.LLM_RATE_LIMIT_PER_MIN,
      warnings,
    },
  };
}
