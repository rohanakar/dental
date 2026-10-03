import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/adapters/db/schema.ts', './src/adapters/db/auth-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://dcad:dcad@localhost:5432/dcad' },
});
