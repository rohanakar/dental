/** Starts the bridge from env. See ../README.md. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from './server.ts';

const env = process.env;
const port = Number(env.CLAUDE_BRIDGE_PORT || 8787);
const host = env.CLAUDE_BRIDGE_HOST || '127.0.0.1';
const cwd = mkdtempSync(join(tmpdir(), 'claude-bridge-'));
const server = createBridge({
  claudeBin: env.CLAUDE_BIN || 'claude',
  model: env.CLAUDE_BRIDGE_MODEL || undefined,
  concurrency: Number(env.CLAUDE_BRIDGE_CONCURRENCY || 1),
  timeoutMs: Number(env.CLAUDE_BRIDGE_TIMEOUT_MS || 180_000),
  cwd,
});

server.listen(port, host, () => {
  process.stderr.write(`[claude-bridge] listening on http://${host}:${port} (claude: ${env.CLAUDE_BIN || 'claude'}, cwd: ${cwd})\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
    process.exit(0);
  });
}
