import { CaseSetup, type LlmRequest, type LlmResponse, type Material, type ToothOrder } from '@dcad/shared';
import { z } from 'zod';
import * as api from '../api/client';
import { RX_SYSTEM_PROMPT } from './prompts';

/** VITA classical shades. */
export const VITA_SHADES = ['A1', 'A2', 'A3', 'A3.5', 'A4', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4', 'D2', 'D3', 'D4'] as const;

export interface RxParse {
  setup: CaseSetup;
  /** False when no supported tooth was found (setup.teeth is then empty). */
  valid: boolean;
  /** 0–1, how much of the setup came from explicit statements. */
  confidence: number;
  /** Reader remarks: defaults used, teeth rejected, ambiguities. */
  notes: string[];
}

const MATERIAL_PATTERNS: Array<[Material, RegExp]> = [
  ['lithium-disilicate', /e\.?\s?max|lithium[\s-]?disilicate|\blisi2?\b/i],
  ['pmma', /\bpmma\b|temporar|provisional/i],
  ['zirconia', /zirconia|\bzr\b|\bzirc\b/i],
];
const QUADRANT: Record<string, number> = { UR: 1, UL: 2, LL: 3, LR: 4 };
const WORD_QUADRANT: Record<string, number> = { 'upper right': 1, 'upper left': 2, 'lower left': 3, 'lower right': 4 };
const TOOTH_CONTEXT = /\b(?:tooth|teeth|fdi|crowns?|unit|units)\b|#/i;
const REF = /\b(?:ref(?:erence)?|case)\s*(?:no\.?|number)?\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})/i;
const SHADE_LABELLED = /\bshade\s*[:=]?\s*([A-D][1-4](?:\.5)?)(?!\w|\.\d)/i;
const SHADE_BARE = /(?<![\w.])([A-D][1-4](?:\.5)?)(?!\w|\.\d)/;

/** Teeth mentioned on one line, in order: FDI numbers (with tooth context), Palmer-style UR7, "lower left 6". */
function teethOnLine(line: string): number[] {
  const found: Array<[number, number]> = [];
  for (const m of line.matchAll(/\b(UR|UL|LL|LR)\s?([1-8])\b/g)) found.push([m.index, QUADRANT[m[1]!]! * 10 + Number(m[2])]);
  for (const m of line.matchAll(/\b(upper|lower)\s+(left|right)\s+(?:first\s+|second\s+|third\s+)?([1-8])\b/gi)) {
    found.push([m.index, WORD_QUADRANT[`${m[1]!.toLowerCase()} ${m[2]!.toLowerCase()}`]! * 10 + Number(m[3])]);
  }
  if (TOOTH_CONTEXT.test(line)) {
    for (const m of line.matchAll(/(?<![\d./:-])#?([1-4][1-8])(?![\d./:])/g)) found.push([m.index, Number(m[1])]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, fdi]) => fdi);
}

/**
 * Rule-based prescription reader: FDI numbers (also #36, UR7, "lower left 6"),
 * material keywords, VITA shade, and a case reference from "Ref:"/"Case:"
 * only (never names). Used offline, as the LLM fallback, and to cross-check
 * the LLM's extraction.
 */
export function parseRxClassical(text: string): RxParse {
  const notes: string[] = [];
  const lines = text.split(/\r?\n/);
  const teeth: number[] = [];
  const restLines: string[] = [];
  for (const line of lines) {
    const onLine = teethOnLine(line);
    for (const fdi of onLine) if (!teeth.includes(fdi)) teeth.push(fdi);
    const recognized =
      onLine.length > 0 || REF.test(line) || SHADE_LABELLED.test(line) || MATERIAL_PATTERNS.some(([, re]) => re.test(line));
    if (!recognized && line.trim()) restLines.push(line.trim());
  }
  if (teeth.length === 0) notes.push('No supported tooth number found.');

  const materials = MATERIAL_PATTERNS.map(([m, re]) => [m, text.search(re)] as const)
    .filter(([, i]) => i >= 0)
    .sort((a, b) => a[1] - b[1]);
  let material: Material = 'zirconia';
  if (materials.length === 0) notes.push('No material given; defaulted to zirconia.');
  else {
    material = materials[0]![0];
    if (materials.length > 1) notes.push(`Several materials mentioned (${materials.map(([m]) => m).join(', ')}); using ${material}.`);
  }

  const shadeRaw = (SHADE_LABELLED.exec(text) ?? SHADE_BARE.exec(text))?.[1]?.toUpperCase();
  const shade = shadeRaw && (VITA_SHADES as readonly string[]).includes(shadeRaw) ? shadeRaw : undefined;
  if (shadeRaw && !shade) notes.push(`Shade "${shadeRaw}" is not a VITA classical shade; left empty.`);

  const patientRef = REF.exec(text)?.[1] ?? '';
  const orders: ToothOrder[] = teeth.map((fdi) => ({ fdi, restoration: 'anatomic-crown', material, ...(shade ? { shade } : {}) }));
  const confidence =
    (teeth.length ? 0.4 : 0) + (materials.length === 1 ? 0.3 : materials.length > 1 ? 0.15 : 0) + (shade ? 0.15 : 0) + (notes.length === 0 ? 0.15 : 0);
  return {
    setup: { patientRef, teeth: orders, notes: restLines.join('\n').slice(0, 4000), connections: [] },
    valid: teeth.length > 0,
    confidence: Math.round(confidence * 100) / 100,
    notes,
  };
}

/** JSON Schema for the forced `submit_case_setup` tool. */
export function caseSetupToolSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(CaseSetup, { io: 'input' }) as Record<string, unknown>;
  return schema;
}

export interface RxDifference {
  field: string;
  llm: string;
  classical: string;
}

/** Field-level differences between two setups (LLM vs rule-based). */
export function compareRx(a: CaseSetup, b: CaseSetup): RxDifference[] {
  const diffs: RxDifference[] = [];
  const add = (field: string, x: unknown, y: unknown) => {
    const sx = x === undefined || x === '' ? '—' : String(x);
    const sy = y === undefined || y === '' ? '—' : String(y);
    if (sx !== sy) diffs.push({ field, llm: sx, classical: sy });
  };
  add('patientRef', a.patientRef, b.patientRef);
  add('teeth', a.teeth.map((t) => t.fdi).sort().join(', '), b.teeth.map((t) => t.fdi).sort().join(', '));
  for (const t of a.teeth) {
    const o = b.teeth.find((u) => u.fdi === t.fdi);
    if (!o) continue;
    add(`${t.fdi} material`, t.material, o.material);
    add(`${t.fdi} shade`, t.shade, o.shade);
  }
  return diffs;
}

export interface RxExtraction {
  setup: CaseSetup;
  valid: boolean;
  source: 'llm' | 'classical';
  notes: string[];
  classical: RxParse;
  /** LLM vs rule-based differences (empty when only the rule-based reader ran). */
  differences: RxDifference[];
}

/**
 * Prescription → CaseSetup with the LLM (forced structured tool call). Falls
 * back to the rule-based reader when the LLM is unavailable, is the mock
 * provider, or returns nothing usable. Nothing is applied: the user confirms.
 */
export async function extractRxWithLlm(text: string, llm: (r: LlmRequest) => Promise<LlmResponse> = api.llm): Promise<RxExtraction> {
  const classical = parseRxClassical(text);
  const fallback = (why: string): RxExtraction => ({
    setup: classical.setup,
    valid: classical.valid,
    source: 'classical',
    notes: [why, ...classical.notes],
    classical,
    differences: [],
  });
  let response: LlmResponse;
  try {
    response = await llm({
      purpose: 'rx-intake',
      system: RX_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Prescription:\n${text}` }] }],
      tools: [{ name: 'submit_case_setup', description: 'Submit the case setup extracted from the prescription.', inputSchema: caseSetupToolSchema() }],
      maxTokens: 1024,
    });
  } catch (e) {
    return fallback(`The AI reader is unavailable (${e instanceof Error ? e.message : String(e)}); used the rule-based reader.`);
  }
  if (response.provider === 'mock') return fallback('No LLM is configured on the server; used the rule-based reader.');
  const call = response.content.find((p) => p.type === 'tool_call' && p.name === 'submit_case_setup');
  if (!call || call.type !== 'tool_call') return fallback('The AI reader returned no case setup; used the rule-based reader.');
  const parsed = CaseSetup.safeParse(call.input);
  if (!parsed.success) return fallback('The AI reader returned an invalid case setup; used the rule-based reader.');
  const setup: CaseSetup = parsed.data;
  return { setup, valid: setup.teeth.length > 0, source: 'llm', notes: [], classical, differences: compareRx(setup, classical.setup) };
}
