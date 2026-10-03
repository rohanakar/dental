/** `pnpm db:migrate` (dev) or `node dist/migrate.js` (container). */
import { createDb } from './client';
import { runMigrations } from './migrate';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const folder = process.env.MIGRATIONS_DIR ?? `${process.cwd()}/drizzle`;
const handle = createDb(url, { max: 1 });
try {
  await runMigrations(handle.db, folder);
  console.log(`migrations applied from ${folder}`);
} finally {
  await handle.close();
}
