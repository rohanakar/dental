# claude-bridge: a local Opus 5.5 behind the Anthropic Messages API

A **dev-only** stand-in for the Anthropic API. It serves `POST /v1/messages` (system, messages with text, base64
image, `tool_use` and `tool_result` blocks, and tools) and answers each request with one `claude -p` run of the
local Claude Code CLI, so the app's Anthropic adapter and the margin harness get a model with tool calling without an
API key. Never use it in production: production uses the API adapters with real keys.

How a request is answered (`src/prompt.ts`, `src/claude.ts`):
- claude runs with no tools, no settings, no session and `--safe-mode`, in an empty temp directory, so it never reads
  the repo's `CLAUDE.md` or settings.
- The request's system prompt becomes `--system-prompt`. The tools (with their JSON schemas), the transcript (tool
  calls and results as text) and the images go in one user message through `--input-format stream-json`.
- The model answers with one decision through `--json-schema`: `{ kind: 'tool_use', name, input }` or
  `{ kind: 'text', text }`. The bridge checks the input against the tool's `input_schema`, retries once on an invalid
  answer, then falls back to a text block.
- The reply has Anthropic's shape (`msg_bridge_<n>`, `toolu_bridge_<n>`, `stop_reason` `tool_use` or `end_turn`,
  usage zeros). The cost and claude's time are in the `x-bridge-cost-usd` and `x-bridge-ms` headers and on stderr.
- Errors are Anthropic-style JSON: 400 for a bad request (including `stream: true`), 502 when the CLI fails (for
  example "Not logged in"), 504 on timeout. 5xx replies carry `x-should-retry: false`, so the SDK does not repeat a
  paid call.

## Run on the host (uses your `claude` login)

```bash
pnpm --filter @dcad/claude-bridge start      # http://127.0.0.1:8787, GET /health
```

| Env | Default | |
|---|---|---|
| `CLAUDE_BRIDGE_PORT` | `8787` | |
| `CLAUDE_BRIDGE_HOST` | `127.0.0.1` | `0.0.0.0` in Docker |
| `CLAUDE_BIN` | `claude` | path to the CLI |
| `CLAUDE_BRIDGE_MODEL` | (the request's `claude-*` id) | forces one model for every request |
| `CLAUDE_BRIDGE_CONCURRENCY` | `1` | claude processes at a time; the rest wait in a queue |
| `CLAUDE_BRIDGE_TIMEOUT_MS` | `180000` | per claude run |

The bridge removes `ANTHROPIC_BASE_URL` (and `ANTHROPIC_API_KEY=bridge`) from claude's environment, so claude never
calls the bridge itself.

## Run in Docker (uses a token)

Create a long-lived token once with `claude setup-token` (needs a Claude subscription), or use an `ANTHROPIC_API_KEY`.

```bash
docker build -t dcad-claude-bridge tools/claude-bridge
docker run --rm -p 127.0.0.1:8787:8787 -e CLAUDE_CODE_OAUTH_TOKEN=<token> dcad-claude-bridge
```

Or with the dev stack, after putting `CLAUDE_CODE_OAUTH_TOKEN=<token>` in the repo-root `.env`:

```bash
./infra/compose.sh -f infra/docker-compose.dev.yml --profile claude-bridge up -d --build claude-bridge
```

## Point the API at it

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_API_KEY=bridge LLM_AGENT_PROVIDER=anthropic LLM_AGENT_MODEL=claude-opus-5-5 pnpm dev:api
```

The Anthropic SDK reads `ANTHROPIC_BASE_URL` itself, so the API needs no change. Inside the Compose stack use
`ANTHROPIC_BASE_URL=http://claude-bridge:8787` in `.env`.

## Cost and latency

Measured on 2026-10-26 with Opus 5.5 (`claude` 2.1.280): a tool call on one 64 px image took 3.7 s end to end (2.2 s
in claude) and cost $0.014; a text answer after a `tool_result` took 3.8 s and cost $0.009. An invalid answer costs a
second run. Prompts grow with the transcript and the images, so long tool loops cost more per turn.

## Limits

No streaming, no `max_tokens` or `temperature` (ignored), one content block per reply (one tool call or one text),
usage always zero. `tool_choice` `auto`, `any`, `tool` and `none` are honoured.
