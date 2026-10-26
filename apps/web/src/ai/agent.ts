import {
  agentToolDefs,
  commandFromToolCall,
  isQueryTool,
  QUERY_TOOLS,
  type ClinicalCommand,
  type LlmContentPart,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  unitKind,
} from '@dcad/shared';
import { ZodError } from 'zod';
import { create } from 'zustand';
import * as api from '../api/client';
import { CommandError } from '../design/reducer';
import { useDesignStore } from '../design/store';
import { crownTool } from '../tools/crownTool';
import { designMetrics, type AgentMetrics } from './metrics';
import { agentSystemPrompt, bridgePromptContext, MAX_AGENT_ACTIONS } from './prompts';

export type LlmFn = (request: LlmRequest) => Promise<LlmResponse>;

export interface AgentAction {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** Short human-readable result, e.g. "occlusal clearance 0.05 mm". */
  summary: string;
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; action: AgentAction }
  | { kind: 'note'; text: string };

export interface AgentRun {
  transcript: LlmMessage[];
  transactionOpen: boolean;
  actions: AgentAction[];
  finalText: string;
  usage: { inputTokens: number; outputTokens: number };
}

const text = (t: string): LlmContentPart => ({ type: 'text', text: t });
const describe = (name: string, input: Record<string, unknown>) =>
  `${name} ${Object.entries(input)
    .filter(([k]) => k !== 'fdi')
    .map(([, v]) => String(v))
    .join(' ')}`.trim();

function errorText(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
  return e instanceof Error ? e.message : String(e);
}

function caseSummary() {
  const { doc, activeFdi } = useDesignStore.getState();
  return {
    activeTooth: activeFdi,
    teeth: doc.setup.teeth.map((t) => ({ fdi: t.fdi, material: t.material, shade: t.shade ?? null })),
    notes: doc.setup.notes,
    steps: Object.fromEntries(doc.teeth.map((t) => [t.fdi, t.steps])),
    adaptation: Object.fromEntries(doc.teeth.map((t) => [t.fdi, t.crown?.kind === 'template' ? (t.crown.adapt ?? {}) : null])),
    params: doc.teeth.find((t) => t.fdi === activeFdi)?.params ?? null,
    // Bridges: units in arch order with their kind, and the connector settings (set_connector changes them).
    bridges: doc.bridges.map((b) => ({ units: b.teeth.map((fdi) => ({ fdi, kind: unitKind(doc.setup, fdi) })), connectors: b.connectors })),
  };
}

const mm = (x: number) => x.toFixed(2);

/** One line per connector, and what keeps the merged bridge from passing its checks. */
function bridgeSummary(m: AgentMetrics): string[] {
  const parts: string[] = [];
  if (m.bridgeError) parts.push(`bridge not designed: ${m.bridgeError}`);
  const b = m.bridge;
  if (!b) return parts;
  for (const c of b.connectors) {
    const area = c.measuredAreaMm2 ?? c.designedAreaMm2;
    const height = c.measuredHeightMm ?? c.heightMm;
    const failures = c.failures.length ? ` (${c.failures.join('; ')})` : '';
    parts.push(`connector ${c.between[0]}-${c.between[1]} ${mm(area)} mm² (min ${c.minAreaMm2}), ${mm(height)} mm high (min ${c.minHeightMm})${failures}`);
  }
  if (b.unionError) parts.push(`not merged into one solid: ${b.unionError}`);
  else if (b.union && !(b.union.printable && b.union.components === 1 && b.union.genus === 0)) parts.push('the merged bridge is not one printable solid');
  else if (b.union && !b.union.seatingUnchanged) parts.push('the merged bridge changed the seating of a retainer');
  return parts;
}

function metricsSummary(m: AgentMetrics | null): string {
  if (!m) return 'no metrics';
  const parts: string[] = [];
  if (m.minOcclusalClearanceMm !== null) parts.push(`occlusal clearance ${m.minOcclusalClearanceMm.toFixed(2)} mm`);
  if (m.mesialContactMm !== null) parts.push(`mesial ${m.mesialContactMm.toFixed(2)} mm`);
  if (m.distalContactMm !== null) parts.push(`distal ${m.distalContactMm.toFixed(2)} mm`);
  if (m.minThicknessMm !== null) parts.push(`min thickness ${m.minThicknessMm.toFixed(2)} mm`);
  if (m.conflicts.length) parts.push(`conflicts: ${m.conflicts.join('; ')}`);
  if (m.adaptation === 'stale') parts.push('adaptation off since the last change (re-apply adapt_occlusion / set_contact)');
  parts.push(...bridgeSummary(m));
  return parts.join(', ') || 'no crown metrics';
}

/** Open the agent's transaction on its first design action. Throws if another (non-agent) proposal is open. */
function ensureTransaction(instruction: string): void {
  const store = useDesignStore.getState();
  if (store.transaction?.author === 'agent') return;
  if (store.transaction) throw new Error(`Another proposal is open ("${store.transaction.label}"); accept or reject it first`);
  const excerpt = instruction.length > 40 ? `${instruction.slice(0, 40)}…` : instruction;
  store.beginTransaction({ label: `Assistant: ${excerpt}`, author: 'agent' });
}

async function executeTool(
  call: Extract<LlmContentPart, { type: 'tool_call' }>,
  state: { actions: number; instruction: string },
): Promise<{ result: Extract<LlmContentPart, { type: 'tool_result' }>; action: AgentAction }> {
  const done = (content: unknown, ok: boolean, summary: string) => ({
    result: { type: 'tool_result' as const, toolCallId: call.id, content: typeof content === 'string' ? content : JSON.stringify(content), ...(ok ? {} : { isError: true }) },
    action: { tool: call.name, input: call.input, ok, summary },
  });

  if (isQueryTool(call.name)) {
    const parsed = QUERY_TOOLS[call.name].safeParse(call.input);
    if (!parsed.success) return done(errorText(parsed.error), false, errorText(parsed.error));
    if (call.name === 'get_case_summary') return done(caseSummary(), true, 'case summary');
    if (call.name === 'get_design_metrics') {
      const m = await designMetrics(undefined, parsed.data.fdi);
      return done(m ?? { error: 'no active tooth' }, Boolean(m), metricsSummary(m));
    }
    return done('capture_view is not supported yet', false, 'capture_view is not supported yet');
  }

  let command: ClinicalCommand | null;
  try {
    command = commandFromToolCall(call.name, call.input);
  } catch (e) {
    return done(`Invalid input: ${errorText(e)}`, false, `invalid input: ${errorText(e)}`);
  }
  if (!command) return done(`Unknown tool "${call.name}"`, false, 'unknown tool');
  if (state.actions >= MAX_AGENT_ACTIONS) {
    return done(`Action limit reached (${MAX_AGENT_ACTIONS} per request). Summarise instead.`, false, 'action limit reached');
  }
  try {
    ensureTransaction(state.instruction);
    useDesignStore.getState().dispatch(command);
  } catch (e) {
    const msg = e instanceof CommandError || e instanceof ZodError || e instanceof Error ? errorText(e) : String(e);
    return done(`Not applied: ${msg}`, false, `not applied: ${msg}`);
  }
  state.actions++;
  // In a bridge, crownTool waits for the whole bridge; the metrics are those of the unit the action changed.
  await crownTool.settled();
  const metrics = await designMetrics(undefined, 'fdi' in command ? command.fdi : undefined);
  return done({ applied: describe(call.name, call.input), metrics }, true, metricsSummary(metrics));
}

/**
 * Browser-side agent loop. The LLM sees the clinical-command tools; every
 * action is a validated command dispatched inside one design transaction
 * (opened on the first action), and its result carries fresh metrics. The
 * user accepts (one undo entry) or reverts the whole run.
 */
export async function runAgent(opts: {
  instruction: string;
  history?: LlmMessage[];
  llm?: LlmFn;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
}): Promise<AgentRun> {
  const llm = opts.llm ?? api.llm;
  const maxTurns = opts.maxTurns ?? 12;
  const { doc, activeFdi } = useDesignStore.getState();
  const tooth = doc.teeth.find((t) => t.fdi === activeFdi);
  const system = agentSystemPrompt({ fdi: activeFdi, crownProposed: Boolean(tooth?.crown), bridge: bridgePromptContext(doc, activeFdi) });
  const tools = agentToolDefs();
  const messages: LlmMessage[] = [...(opts.history ?? []), { role: 'user', content: [text(opts.instruction)] }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const actions: AgentAction[] = [];
  const state = { actions: 0, instruction: opts.instruction };
  let finalText = '';
  let finished = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await llm({ purpose: 'agent', system, messages, tools, maxTokens: 1024 });
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    if (response.content.length === 0) {
      finished = true;
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    const said = response.content.flatMap((p) => (p.type === 'text' && p.text.trim() ? [p.text] : []));
    for (const t of said) opts.onEvent?.({ kind: 'text', text: t });
    if (said.length) finalText = said.join('\n');
    const calls = response.content.filter((p): p is Extract<LlmContentPart, { type: 'tool_call' }> => p.type === 'tool_call');
    if (calls.length === 0) {
      finished = true;
      break;
    }
    const results: LlmContentPart[] = [];
    for (const call of calls) {
      const { result, action } = await executeTool(call, state);
      results.push(result);
      if (!isQueryTool(call.name) || !action.ok) actions.push(action);
      opts.onEvent?.({ kind: 'tool', action });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!finished) {
    const note = `Stopped after ${maxTurns} turns without a final answer.`;
    opts.onEvent?.({ kind: 'note', text: note });
    finalText = finalText ? `${finalText}\n${note}` : note;
  }
  return {
    transcript: messages,
    transactionOpen: useDesignStore.getState().transaction?.author === 'agent',
    actions,
    finalText,
    usage,
  };
}

/** Keep the assistant's changes (one undo entry, saved versions record author "agent"). */
export function acceptAgentChanges(): void {
  if (useDesignStore.getState().transaction?.author === 'agent') useDesignStore.getState().commitTransaction();
}

/** Discard the assistant's changes. */
export function revertAgentChanges(): void {
  if (useDesignStore.getState().transaction?.author === 'agent') useDesignStore.getState().rollbackTransaction();
}

/**
 * Keep at most `max` messages, starting at a user text turn so tool results
 * are never separated from the tool calls they answer.
 */
export function trimHistory(messages: LlmMessage[], max: number): LlmMessage[] {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && !(messages[start]!.role === 'user' && messages[start]!.content.some((p) => p.type === 'text'))) start++;
  return messages.slice(start);
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'note' | 'error';
  text: string;
  ok?: boolean;
}

interface AssistantState {
  messages: ChatMessage[];
  /** Provider transcript, so follow-up instructions keep context. */
  history: LlmMessage[];
  running: boolean;
  error: string | null;
  send(instruction: string, llm?: LlmFn): Promise<void>;
  accept(): void;
  revert(): void;
  clear(): void;
}

/** Chat state for the assistant panel. */
export const useAssistant = create<AssistantState>()((set, get) => ({
  messages: [],
  history: [],
  running: false,
  error: null,
  async send(instruction, llm) {
    const trimmed = instruction.trim();
    if (!trimmed || get().running) return;
    set({ running: true, error: null, messages: [...get().messages, { role: 'user', text: trimmed }] });
    const push = (m: ChatMessage) => set({ messages: [...get().messages, m] });
    try {
      const run = await runAgent({
        instruction: trimmed,
        history: get().history,
        llm,
        onEvent: (e) => {
          if (e.kind === 'text') push({ role: 'assistant', text: e.text });
          else if (e.kind === 'note') push({ role: 'note', text: e.text });
          else push({ role: 'tool', text: `${describe(e.action.tool, e.action.input)} → ${e.action.summary}`, ok: e.action.ok });
        },
      });
      set({ history: trimHistory(run.transcript, 40) });
    } catch (e) {
      const message = errorText(e);
      set({ error: message });
      push({ role: 'error', text: message });
    } finally {
      set({ running: false });
    }
  },
  accept() {
    acceptAgentChanges();
    set({ messages: [...get().messages, { role: 'note', text: 'Changes accepted.' }] });
  },
  revert() {
    revertAgentChanges();
    set({ messages: [...get().messages, { role: 'note', text: 'Changes reverted.' }] });
  },
  clear() {
    set({ messages: [], history: [], error: null });
  },
}));
