import type { LlmContentPart, LlmMessage, LlmRequest, LlmResponse, LlmToolDef } from '@dcad/shared';
import {
  addAnchor,
  marginReport,
  moveAnchor,
  removeAnchor,
  rerunAutoMargin,
  smoothWork,
  type MarginReport,
  type MarginScan,
  type MarginWork,
} from '../geometry/marginTools';

/**
 * The margin repair loop (specs/2026-10-26-margin-ai.md): a model looks at the margin report and calls margin tools,
 * at most MARGIN_TOOL_BUDGET times, until the margin gate passes or it gives up. The tools are deterministic geometry
 * (geometry/marginTools.ts); the model chooses which and where, never coordinates. The loop keeps the best margin it
 * has seen, so a bad call never leaves the margin worse than it started.
 */

export type LlmFn = (request: LlmRequest) => Promise<LlmResponse>;

export const MARGIN_TOOL_BUDGET = 10;

const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

export const MARGIN_TOOLS: LlmToolDef[] = [
  { name: 'get_margin_report', description: 'The current margin: whether it passes, its length, sharpest turn, wander, kinks by side with the nearest anchor, and every anchor (index, side, height below the prep top, radius).', inputSchema: object({}) },
  {
    name: 'rerun_auto_margin',
    description: 'Find the margin again from scratch: radial profiles round the prep top. More profiles give more anchors; ring_filter drops anchors that leave the smooth ring their neighbours make (false edges from scan noise); smooth evens out jitter.',
    inputSchema: object({ profiles: { type: 'integer', minimum: 8, maximum: 64 }, ring_filter: { type: 'boolean' }, smooth: { type: 'boolean' } }),
  },
  { name: 'remove_anchor', description: 'Drop one anchor (e.g. the one nearest a kink, or one much higher or lower than its neighbours) and re-trace.', inputSchema: object({ index: { type: 'integer', minimum: 0 } }) },
  { name: 'add_anchor', description: 'Add an anchor on the finish line between anchor `after` and the next one (found on the radial profile at that angle) and re-trace. Use on a long gap.', inputSchema: object({ after: { type: 'integer', minimum: 0 } }) },
  {
    name: 'move_anchor',
    description: 'Move one anchor by up to 1 mm toward the gingiva, the occlusal surface, outward or inward, back onto the scan, and re-trace.',
    inputSchema: object({ index: { type: 'integer', minimum: 0 }, toward: { type: 'string', enum: ['gingival', 'occlusal', 'outward', 'inward'] }, mm: { type: 'number', minimum: 0.05, maximum: 1 } }),
  },
  { name: 'smooth_margin', description: 'Smooth the traced line over a window (mm) and put it back on the scan. For small jitter kinks.', inputSchema: object({ window_mm: { type: 'number', minimum: 0.2, maximum: 1 } }) },
  {
    name: 'finish',
    description: 'Stop. verdict: fixed (the report passes), cannot_fix, or not_a_prep (no consistent finish line all round: the tooth looks unprepared).',
    inputSchema: object({ verdict: { type: 'string', enum: ['fixed', 'cannot_fix', 'not_a_prep'] }, reason: { type: 'string' } }),
  },
];

export const MARGIN_AGENT_SYSTEM = `You repair the automatic margin line of a crown preparation (a prepared tooth) on a dental intraoral scan.
The margin is the finish line where the crown's edge will sit. It was found automatically from radial height profiles around the prep top, and traced as a closed line through anchor points.
You cannot give coordinates. You only call the tools; each one returns the new margin report.
Goal: a report that passes (no line doubling back over 120°, no detour away from the anchors over wander 1.15, length 8–60 mm, edge found on at least 75% of the way round), changing as little as needed.
Strategy: first try rerun_auto_margin with more profiles (24–48), ring_filter true and smooth true. Then fix what is left: remove the anchor nearest a kink when it sits much higher or lower than its neighbours (a false edge); add an anchor on a long gap; smooth for small jitter.
If the line doubles back on many sides and no rerun helps, the tooth is probably not prepared (a natural tooth has no finish line, only the gum line): finish with not_a_prep.
You have at most ${MARGIN_TOOL_BUDGET} tool calls. Call finish as soon as the report passes.`;

export interface MarginAgentResult {
  work: MarginWork;
  report: MarginReport;
  calls: number;
  verdict: 'fixed' | 'cannot_fix' | 'not_a_prep' | 'budget' | 'stopped';
  reason: string;
  /** One line per call: tool, arguments, outcome. */
  log: string[];
}

/** Better first: passing, then fewer problems, then less wander, then the gentler sharpest turn. */
const rank = (r: MarginReport) => [r.passes ? 0 : 1, r.problems.length, r.wander, r.sharpestTurnDeg];
const isBetter = (a: MarginReport, b: MarginReport) => {
  const x = rank(a), y = rank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
};

function runTool(scan: MarginScan, work: MarginWork, name: string, input: Record<string, unknown>): MarginWork {
  switch (name) {
    case 'get_margin_report':
      return work;
    case 'rerun_auto_margin':
      return rerunAutoMargin(scan, { profiles: Number(input.profiles ?? 32), ringFilter: Boolean(input.ring_filter), smooth: Boolean(input.smooth) });
    case 'remove_anchor':
      return removeAnchor(scan, work, Number(input.index));
    case 'add_anchor':
      return addAnchor(scan, work, Number(input.after));
    case 'move_anchor':
      return moveAnchor(scan, work, Number(input.index), input.toward as 'gingival' | 'occlusal' | 'outward' | 'inward', Number(input.mm));
    case 'smooth_margin':
      return smoothWork(scan, work, Number(input.window_mm ?? 0.4));
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

/** The report as the model reads it: compact JSON without every anchor when there are many. */
const reportText = (r: MarginReport) => JSON.stringify({ ...r, anchors: r.anchors.length > 24 ? `${r.anchors.length} anchors (ask get_margin_report for detail)` : r.anchors });

export async function runMarginAgent(opts: { llm: LlmFn; scan: MarginScan; start: MarginWork; budget?: number }): Promise<MarginAgentResult> {
  const budget = opts.budget ?? MARGIN_TOOL_BUDGET;
  let work = opts.start;
  let report = marginReport(opts.scan, work);
  let best = { work, report };
  const log: string[] = [];
  const messages: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: `Current margin report:\n${reportText(report)}\nRepair the margin.` }] }];
  let calls = 0;
  while (calls < budget) {
    const response = await opts.llm({ purpose: 'agent', system: MARGIN_AGENT_SYSTEM, messages, tools: MARGIN_TOOLS, maxTokens: 1024 });
    const toolCalls = response.content.filter((p): p is Extract<LlmContentPart, { type: 'tool_call' }> => p.type === 'tool_call');
    messages.push({ role: 'assistant', content: response.content.length ? response.content : [{ type: 'text', text: '(no answer)' }] });
    if (toolCalls.length === 0) return { work: best.work, report: best.report, calls, verdict: 'stopped', reason: response.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim(), log };
    const results: LlmContentPart[] = [];
    for (const call of toolCalls) {
      calls++;
      if (call.name === 'finish') {
        const verdict = call.input.verdict as MarginAgentResult['verdict'];
        log.push(`finish ${verdict}: ${String(call.input.reason ?? '')}`);
        return { work: best.work, report: best.report, calls, verdict, reason: String(call.input.reason ?? ''), log };
      }
      try {
        work = runTool(opts.scan, work, call.name, call.input);
        report = marginReport(opts.scan, work);
        if (isBetter(report, best.report)) best = { work, report };
        log.push(`${call.name} ${JSON.stringify(call.input)} → ${report.passes ? 'passes' : report.problems.join('; ')}`);
        results.push({ type: 'tool_result', toolCallId: call.id, content: reportText(report) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.push(`${call.name} ${JSON.stringify(call.input)} → error: ${message}`);
        results.push({ type: 'tool_result', toolCallId: call.id, content: message, isError: true });
      }
      if (calls >= budget) break;
    }
    messages.push({ role: 'user', content: results.length ? results : [{ type: 'text', text: 'Continue.' }] });
  }
  return { work: best.work, report: best.report, calls, verdict: best.report.passes ? 'fixed' : 'budget', reason: `tool budget of ${budget} reached`, log };
}
