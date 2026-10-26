/** One `claude -p` run: no tools, no settings, no session, one stream-json user message, structured output. */
import { spawn } from 'node:child_process';
import { BridgeError, type ClaudeCall } from './prompt.ts';

export interface ClaudeOptions {
  bin: string;
  model: string;
  /** An empty temp directory, so claude finds no CLAUDE.md or project settings. */
  cwd: string;
  timeoutMs: number;
}

export interface ClaudeResult {
  isError: boolean;
  /** `success`, or an error subtype such as `error_max_structured_output_retries`. */
  subtype: string;
  structured: unknown;
  result: string;
  costUsd: number;
  ms: number;
}

export function claudeArgs(call: ClaudeCall, model: string): string[] {
  return [
    '-p',
    `--model=${model}`,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--safe-mode',
    // `=` form, so a value that starts with "-" is never read as an option.
    `--system-prompt=${call.systemPrompt}`,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    `--json-schema=${JSON.stringify(call.schema)}`,
  ];
}

/**
 * The child's environment: never point claude back at the bridge or at the bridge's placeholder key, and drop
 * empty credentials (Compose passes unset variables as "") so claude falls back to its own login.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  if (env.ANTHROPIC_API_KEY === 'bridge') delete env.ANTHROPIC_API_KEY;
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) if (!env[key]) delete env[key];
  return env;
}

export function runClaude(call: ClaudeCall, opts: ClaudeOptions): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin, claudeArgs(call, opts.model), { cwd: opts.cwd, env: childEnv(), stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.stdin.on('error', () => {}); // the child may exit before reading; the exit handler reports it
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new BridgeError(502, 'api_error', `cannot run ${opts.bin}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new BridgeError(504, 'timeout_error', `claude took longer than ${opts.timeoutMs} ms`));
      const line = stdout
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('{') && l.includes('"type":"result"'));
      let r: Record<string, unknown> | undefined;
      try {
        r = line ? JSON.parse(line) : undefined;
      } catch {
        r = undefined;
      }
      if (!r) {
        const why = (stderr || stdout).trim().split('\n').slice(-3).join(' ') || 'no output';
        return reject(new BridgeError(502, 'api_error', `claude exited with code ${code} and no result: ${why}`));
      }
      resolve({
        isError: r.is_error === true,
        subtype: String(r.subtype ?? ''),
        structured: r.structured_output,
        result: typeof r.result === 'string' ? r.result : '',
        costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0,
        ms: typeof r.duration_ms === 'number' ? r.duration_ms : 0,
      });
    });
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: call.content } })}\n`);
  });
}
