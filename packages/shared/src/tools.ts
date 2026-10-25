import { z } from 'zod';
import { Fdi } from './case';
import { CLINICAL_COMMANDS, type ClinicalCommand } from './commands';
import type { LlmToolDef } from './llm';

/**
 * LLM agent tools. Action tools are generated from the clinical command
 * schemas, so the agent can only do what a user could do through a command.
 * Query tools read deterministic metrics; the agent never edits geometry.
 */

export const QUERY_TOOLS = {
  get_case_summary: z
    .object({})
    .describe('Case setup (teeth, material, shade, notes) and which design steps are done or stale.'),
  get_design_metrics: z
    .object({ fdi: Fdi })
    .describe(
      'Measured design metrics for one tooth: min occlusal clearance, mesial/distal contact distances, min thickness, margin length. All in mm.',
    ),
  capture_view: z
    .object({ fdi: Fdi, view: z.enum(['occlusal', 'buccal', 'lingual', 'mesial', 'distal']) })
    .describe('Render a PNG of the current design from a standard view.'),
} as const;
export type QueryToolName = keyof typeof QUERY_TOOLS;

/** moveCrown -> move_crown */
export const toolNameForCommand = (commandType: string): string =>
  commandType.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * The schema of what the model sends (io: 'input'). A tuple's output schema uses `prefixItems`, which OpenAI strict
 * mode rejects; FdiPair's input side is a plain two-item array.
 */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
}

export function agentToolDefs(): LlmToolDef[] {
  const defs: LlmToolDef[] = [];
  for (const schema of CLINICAL_COMMANDS) {
    const { type, ...inputShape } = schema.shape;
    defs.push({
      name: toolNameForCommand(type.value),
      description: schema.description ?? '',
      inputSchema: toJsonSchema(z.object(inputShape)),
    });
  }
  for (const [name, schema] of Object.entries(QUERY_TOOLS)) {
    defs.push({ name, description: schema.description ?? '', inputSchema: toJsonSchema(schema) });
  }
  return defs;
}

const commandByToolName = new Map(
  CLINICAL_COMMANDS.map((schema) => [toolNameForCommand(schema.shape.type.value), schema] as const),
);

export const isQueryTool = (name: string): name is QueryToolName => name in QUERY_TOOLS;

/**
 * Validate an LLM tool call against its command schema. Returns null for
 * unknown tools; throws a ZodError for invalid input (report it back to the
 * model as a tool error).
 */
export function commandFromToolCall(name: string, input: Record<string, unknown>): ClinicalCommand | null {
  const schema = commandByToolName.get(name);
  if (!schema) return null;
  return schema.parse({ ...input, type: schema.shape.type.value }) as ClinicalCommand;
}
