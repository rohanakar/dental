/**
 * The bridge: `POST /v1/messages` in the Anthropic Messages shape, answered by `claude -p`; `GET /health`.
 * Each request is one claude run (two when the first answer is invalid), at most `concurrency` at a time.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { runClaude } from './claude.ts';
import { BridgeError, buildCall, checkDecision, parseRequest, type Decision, type MessagesRequest } from './prompt.ts';

export interface BridgeConfig {
  claudeBin: string;
  /** Forces this model for every request (env CLAUDE_BRIDGE_MODEL); otherwise the request's `claude-*` id. */
  model?: string;
  concurrency: number;
  timeoutMs: number;
  /** Working directory for claude: empty, outside the repo. */
  cwd: string;
  log?: (line: string) => void;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const ATTEMPTS = 2;

class Queue {
  running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  get queued() {
    return this.waiting.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < this.limit) this.running++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // the slot is handed over on release
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown) {
  const e = err instanceof BridgeError ? err : new BridgeError(500, 'api_error', String((err as Error)?.message ?? err));
  // The bridge has already retried; tell the SDK not to spend more calls on it.
  send(res, e.status, { type: 'error', error: { type: e.type, message: e.message } }, e.status >= 500 ? { 'x-should-retry': 'false' } : {});
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, 'request_too_large', `body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError(400, 'invalid_request_error', 'body: not valid JSON');
  }
}

export function createBridge(cfg: BridgeConfig): Server {
  const queue = new Queue(Math.max(1, cfg.concurrency));
  const log = cfg.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let n = 0;

  async function answer(req: MessagesRequest, model: string) {
    let costUsd = 0;
    let ms = 0;
    let retry: { answer: unknown; errors: string[] } | undefined;
    let decision: Decision | undefined;
    let attempts = 0;
    while (!decision && attempts < ATTEMPTS) {
      attempts++;
      const r = await runClaude(buildCall(req, retry), { bin: cfg.claudeBin, model, cwd: cfg.cwd, timeoutMs: cfg.timeoutMs });
      costUsd += r.costUsd;
      ms += r.ms;
      // A failed structured answer is an invalid answer; any other CLI error is the upstream failing.
      if (r.isError && r.subtype !== 'error_max_structured_output_retries') {
        throw new BridgeError(502, 'api_error', `claude: ${r.result || r.subtype || 'error'}`);
      }
      const checked = r.isError ? { errors: ['no structured answer'] } : checkDecision(r.structured, req);
      decision = checked.decision;
      if (!decision) retry = { answer: r.structured ?? null, errors: checked.errors };
    }
    if (!decision) {
      const prev = retry?.answer as { text?: unknown } | null | undefined;
      const text =
        typeof prev?.text === 'string' && prev.text.trim()
          ? prev.text
          : `(claude-bridge) no valid answer after ${ATTEMPTS} attempts: ${retry?.errors.join('; ')}`;
      decision = { kind: 'text', text };
    }
    return { decision, costUsd, ms, attempts };
  }

  async function messages(httpReq: IncomingMessage, res: ServerResponse) {
    const req = parseRequest(await readJson(httpReq));
    const model = cfg.model ?? req.model;
    if (!/^claude-/.test(model)) throw new BridgeError(400, 'invalid_request_error', `model: "${model}" is not a claude-* id`);
    const t0 = Date.now();
    let started = 0;
    const out = await queue.run(() => {
      started = Date.now();
      return answer(req, model);
    });
    const id = ++n;
    const { decision } = out;
    const content =
      decision.kind === 'tool_use'
        ? [{ type: 'tool_use', id: `toolu_bridge_${id}`, name: decision.name, input: decision.input }]
        : [{ type: 'text', text: decision.text }];
    log(
      `[claude-bridge] msg_bridge_${id} ${model} ${decision.kind === 'tool_use' ? `tool_use ${decision.name}` : 'text'}` +
        ` attempts=${out.attempts} cost_usd=${out.costUsd.toFixed(4)} claude_ms=${out.ms} queued_ms=${started - t0}`,
    );
    send(
      res,
      200,
      {
        id: `msg_bridge_${id}`,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: decision.kind === 'tool_use' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      { 'x-bridge-cost-usd': out.costUsd.toFixed(6), 'x-bridge-ms': String(out.ms), 'x-bridge-attempts': String(out.attempts) },
    );
  }

  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, model: cfg.model ?? null, concurrency: cfg.concurrency, running: queue.running, queued: queue.queued });
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      return void messages(req, res).catch((err: unknown) => {
        log(`[claude-bridge] error: ${(err as Error)?.message ?? err}`);
        sendError(res, err);
      });
    }
    sendError(res, new BridgeError(404, 'not_found_error', `${req.method} ${path} is not served by the bridge`));
  });
}
