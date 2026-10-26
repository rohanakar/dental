/**
 * Anthropic Messages request → one `claude -p` call (system prompt, one stream-json user message, a decision
 * schema), and the model's structured answer → one checked decision.
 */
import { checkSchema, type JsonSchema } from './schema.ts';

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ImageBlock {
  type: 'image';
  source: Record<string, unknown>;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}
export interface ToolDef {
  name: string;
  description?: string;
  input_schema: JsonSchema;
}
export interface ToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
}
export interface MessagesRequest {
  model: string;
  system?: string | TextBlock[];
  messages: MessageParam[];
  tools?: ToolDef[];
  tool_choice?: ToolChoice;
  stream?: boolean;
}

/** A request the bridge cannot serve; the server turns it into an Anthropic-style error. */
export class BridgeError extends Error {
  readonly status: number;
  readonly type: string;
  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const invalid = (message: string) => new BridgeError(400, 'invalid_request_error', message);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the parts of the request the bridge uses; everything else (max_tokens, temperature, …) is ignored. */
export function parseRequest(body: unknown): MessagesRequest {
  if (!isObj(body)) throw invalid('body: expected a JSON object');
  if (body.stream === true) throw invalid('stream: streaming is not supported by the bridge');
  if (typeof body.model !== 'string' || !body.model) throw invalid('model: required');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid('messages: expected a non-empty array');
  body.messages.forEach((m: unknown, i) => {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant')) throw invalid(`messages.${i}.role: expected user or assistant`);
    if (typeof m.content === 'string') return;
    if (!Array.isArray(m.content)) throw invalid(`messages.${i}.content: expected a string or an array`);
    m.content.forEach((b: unknown, j) => {
      const known = ['text', 'image', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'];
      if (!isObj(b) || !known.includes(b.type as string)) {
        throw invalid(`messages.${i}.content.${j}.type: expected one of ${known.join(', ')}`);
      }
    });
  });
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw invalid('tools: expected an array');
    body.tools.forEach((t: unknown, i) => {
      if (!isObj(t) || typeof t.name !== 'string' || !isObj(t.input_schema)) {
        throw invalid(`tools.${i}: expected { name, input_schema }`);
      }
    });
  }
  const choice = body.tool_choice;
  if (choice !== undefined && (!isObj(choice) || !['auto', 'any', 'tool', 'none'].includes(choice.type as string))) {
    throw invalid('tool_choice.type: expected auto, any, tool or none');
  }
  if (isObj(choice) && choice.type === 'tool' && !((body.tools ?? []) as ToolDef[]).some((t) => t.name === choice.name)) {
    throw invalid('tool_choice.name: not one of the tools');
  }
  return body as unknown as MessagesRequest;
}

export type UserPart = TextBlock | ImageBlock;

export interface ClaudeCall {
  systemPrompt: string;
  /** The single user message sent through `--input-format stream-json`. */
  content: UserPart[];
  /** Passed to `--json-schema`. */
  schema: JsonSchema;
}

export type Decision = { kind: 'tool_use'; name: string; input: Record<string, unknown> } | { kind: 'text'; text: string };

const bridgeNote = (withTools: boolean) =>
  withTools
    ? `---
How this conversation reaches you: the tools you may call, the conversation so far and the instructions for this \
turn are all in the user message. You cannot run anything yourself. You answer with exactly one decision through the \
structured output: call one of the listed tools, or reply in text. The caller runs the tool and comes back with its \
result in a later turn.`
    : `---
How this conversation reaches you: the conversation so far and the instructions for this turn are in the user \
message. You answer in text through the structured output.`;

/** Tools the model may call on this turn ([] = text only). */
function callableTools(req: MessagesRequest): ToolDef[] {
  const tools = req.tools ?? [];
  if (req.tool_choice?.type === 'none') return [];
  if (req.tool_choice?.type === 'tool') return tools.filter((t) => t.name === req.tool_choice!.name);
  return tools;
}

const toolRequired = (req: MessagesRequest) =>
  callableTools(req).length > 0 && (req.tool_choice?.type === 'any' || req.tool_choice?.type === 'tool');

/** Collects text and images in order, merging adjacent text into one block. */
class Parts {
  readonly list: UserPart[] = [];
  text(s: string) {
    const last = this.list.at(-1);
    if (last?.type === 'text') last.text += s;
    else this.list.push({ type: 'text', text: s });
  }
  image(block: ImageBlock) {
    this.list.push({ type: 'image', source: block.source });
  }
}

export function buildCall(req: MessagesRequest, retry?: { answer: unknown; errors: string[] }): ClaudeCall {
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text).join('\n\n');
  const tools = callableTools(req);
  const parts = new Parts();

  if (tools.length) {
    parts.text('<tools>\nYou may call one of these tools.\n');
    for (const t of tools) {
      parts.text(`\n<tool name="${t.name}">\n${t.description ?? ''}\nInput schema: ${JSON.stringify(t.input_schema)}\n</tool>\n`);
    }
    parts.text('</tools>\n\n');
  }

  const toolNames = new Map<string, string>();
  parts.text('<conversation>\n');
  for (const m of req.messages) {
    parts.text(`<turn role="${m.role}">\n`);
    const blocks: ContentBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === 'text') parts.text(`${b.text}\n`);
      else if (b.type === 'image') parts.image(b);
      else if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        parts.text(`<tool_call id="${b.id}" name="${b.name}">${JSON.stringify(b.input ?? {})}</tool_call>\n`);
      } else if (b.type === 'tool_result') {
        const name = toolNames.get(b.tool_use_id) ?? 'unknown';
        parts.text(`<tool_result id="${b.tool_use_id}" name="${name}"${b.is_error ? ' error="true"' : ''}>\n`);
        for (const c of typeof b.content === 'string' ? [{ type: 'text' as const, text: b.content }] : (b.content ?? [])) {
          if (c.type === 'text') parts.text(`${c.text}\n`);
          else if (c.type === 'image') parts.image(c);
        }
        parts.text('</tool_result>\n');
      }
    }
    parts.text('</turn>\n');
  }
  parts.text('</conversation>\n\n');

  const names = tools.map((t) => t.name);
  const lines = ['<instructions>', 'Write the assistant\'s next turn as exactly one decision, given through the structured output:'];
  if (tools.length) {
    lines.push(
      `- {"kind":"tool_use","name":<one of ${names.join(', ')}>,"input":{…}} calls one tool. The input must match that tool's input schema.`,
    );
  }
  if (toolRequired(req)) lines.push('A tool call is required on this turn.');
  else lines.push('- {"kind":"text","text":"…"} replies in text.');
  if (retry) {
    lines.push(`Your previous answer ${JSON.stringify(retry.answer)} was not valid: ${retry.errors.join('; ')}. Answer again.`);
  }
  lines.push('</instructions>');
  parts.text(lines.join('\n'));

  return {
    systemPrompt: `${system || 'You are a helpful assistant.'}\n\n${bridgeNote(tools.length > 0)}`,
    content: parts.list,
    schema: decisionSchema(names, toolRequired(req)),
  };
}

function decisionSchema(names: string[], toolRequired: boolean): JsonSchema {
  if (!names.length) {
    return {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['text'] }, text: { type: 'string' } },
      required: ['kind', 'text'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: toolRequired ? ['tool_use'] : ['tool_use', 'text'] },
      name: { type: 'string', enum: names },
      input: { type: 'object' },
      text: { type: 'string' },
    },
    required: toolRequired ? ['kind', 'name', 'input'] : ['kind'],
    additionalProperties: false,
  };
}

/** Checks the model's answer against the request: a known tool with a valid input, or (when allowed) text. */
export function checkDecision(answer: unknown, req: MessagesRequest): { decision?: Decision; errors: string[] } {
  if (!isObj(answer)) return { errors: ['the answer is not an object'] };
  if (answer.kind === 'tool_use') {
    const tool = callableTools(req).find((t) => t.name === answer.name);
    if (!tool) return { errors: [`"${String(answer.name)}" is not one of the tools`] };
    const input = answer.input ?? {};
    if (!isObj(input)) return { errors: ['input must be an object'] };
    const errors = checkSchema(input, tool.input_schema);
    return errors.length ? { errors } : { decision: { kind: 'tool_use', name: tool.name, input }, errors };
  }
  if (answer.kind === 'text') {
    if (toolRequired(req)) return { errors: ['a tool call is required'] };
    if (typeof answer.text !== 'string' || !answer.text.trim()) return { errors: ['text is empty'] };
    return { decision: { kind: 'text', text: answer.text }, errors: [] };
  }
  return { errors: ['kind must be tool_use or text'] };
}
