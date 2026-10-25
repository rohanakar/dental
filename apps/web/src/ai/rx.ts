import {
  archIndex,
  archOrder,
  type BridgeValidation,
  CaseSetup,
  type FdiPair,
  jawOf,
  type LlmRequest,
  type LlmResponse,
  type Material,
  normalizeConnections,
  type ToothOrder,
  validateBridges,
} from '@dcad/shared';
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
const TOOTH_CONTEXT = /\b(?:tooth|teeth|fdi|crowns?|units?|bridges?|pontics?|cantilevers?|abutments?|retainers?)\b|#/i;
const REF = /\b(?:ref(?:erence)?|case)\s*(?:no\.?|number)?\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})/i;
const SHADE_LABELLED = /\bshade\s*[:=]?\s*([A-D][1-4](?:\.5)?)(?!\w|\.\d)/i;
const SHADE_BARE = /(?<![\w.])([A-D][1-4](?:\.5)?)(?!\w|\.\d)/;

/** "35-37", "35–37", "35 to 37", and the bridge notation "13x23". */
const RANGE = /(?<![\d./:-])#?([1-4][1-8])\s*(?:([x×])|[-–—]|\bto\b)\s*#?([1-4][1-8])(?![\d./:])/gi;
/** What a list of teeth is called: pontics (also cantilevers), abutments (crowns, retainers) or a bridge. */
const ROLE_WORD = /\b(?:(pontics?|cantilevers?)|(abutments?|retainers?|crowns?)|(bridges?))\b/gi;
/** Between teeth of one list: "11, 21", "12 and 22", "14/15". */
const LIST_GAP = /^(?:[\s,&/+]|\band\b|\bor\b)*$/i;
/** Between a list and the word naming it: "pontic 22", "pontics: 36", "bridge from 13 to 23", "11, 21 crowns". */
const BIND_GAP = /^(?:[\s:#(]|\b(?:on|at|for|from|in|of|tooth|teeth|units?)\b)*$/i;

type Role = 'pontic' | 'abutment' | 'bridge';

/** A tooth, a span of teeth, or a role word on one line. */
interface Token {
  start: number;
  end: number;
  /** Empty for a role word. Spans are listed from the first-written end to the other. */
  teeth: number[];
  role?: Role;
  /** "13x23": a bridge by its notation alone. */
  bridge?: boolean;
}

/** The tooth at an arch position (the inverse of archIndex). */
function atArchIndex(upper: boolean, i: number): number {
  const right = i < 8;
  const quadrant = upper ? (right ? 1 : 2) : right ? 4 : 3;
  return quadrant * 10 + (right ? 8 - i : i - 7);
}

/** Teeth from a to b along the arch, both included, in that direction; empty across jaws. */
function span(a: number, b: number): number[] {
  if (jawOf(a) !== jawOf(b)) return [];
  const upper = jawOf(a) === 'upper';
  const [i, j] = [archIndex(a), archIndex(b)];
  const step = i <= j ? 1 : -1;
  const teeth: number[] = [];
  for (let k = i; k !== j + step; k += step) teeth.push(atArchIndex(upper, k));
  return teeth;
}

/** Teeth, spans and role words on one line, in order: FDI numbers (with tooth context), Palmer-style UR7, "lower left 6". */
function tokensOnLine(line: string): Token[] {
  const tokens: Token[] = [];
  const context = TOOTH_CONTEXT.test(line);
  for (const m of line.matchAll(RANGE)) {
    const teeth = span(Number(m[1]), Number(m[3]));
    if (teeth.length >= 2 && (context || m[2])) tokens.push({ start: m.index, end: m.index + m[0].length, teeth, bridge: Boolean(m[2]) });
  }
  const free = (i: number) => !tokens.some((t) => i >= t.start && i < t.end);
  const tooth = (m: RegExpMatchArray, fdi: number) => free(m.index!) && tokens.push({ start: m.index!, end: m.index! + m[0].length, teeth: [fdi] });
  for (const m of line.matchAll(/\b(UR|UL|LL|LR)\s?([1-8])\b/g)) tooth(m, QUADRANT[m[1]!]! * 10 + Number(m[2]));
  for (const m of line.matchAll(/\b(upper|lower)\s+(left|right)\s+(?:first\s+|second\s+|third\s+)?([1-8])\b/gi)) {
    tooth(m, WORD_QUADRANT[`${m[1]!.toLowerCase()} ${m[2]!.toLowerCase()}`]! * 10 + Number(m[3]));
  }
  if (context) for (const m of line.matchAll(/(?<![\d./:-])#?([1-4][1-8])(?![\d./:])/g)) tooth(m, Number(m[1]));
  for (const m of line.matchAll(ROLE_WORD)) {
    tokens.push({ start: m.index, end: m.index + m[0].length, teeth: [], role: m[1] ? 'pontic' : m[2] ? 'abutment' : 'bridge' });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

interface LineReading {
  /** Teeth in the order written; spans expanded. */
  teeth: number[];
  /** Teeth a role word names as pontic or abutment. */
  named: Map<number, 'pontic' | 'abutment'>;
  /** Bridges written as such ("bridge 35-37", "13x23", "bridge 35, 37"), each along the arch. */
  spans: number[][];
}

/** Group a line's teeth into lists ("11, 21") and bind each list to the role word written next to it. */
function readLine(line: string): LineReading {
  const tokens = tokensOnLine(line);
  const reading: LineReading = { teeth: [], named: new Map(), spans: [] };
  let i = 0;
  while (i < tokens.length) {
    if (!tokens[i]!.teeth.length) {
      i++;
      continue;
    }
    const list = [tokens[i]!];
    let j = i + 1;
    while (j < tokens.length && tokens[j]!.teeth.length && LIST_GAP.test(line.slice(tokens[j - 1]!.end, tokens[j]!.start))) list.push(tokens[j++]!);
    // The word right after a list names it ("12 and 22 cantilever pontics"), else the word right before ("pontic 22").
    const [next, prev] = [tokens[j], tokens[i - 1]];
    const role =
      next?.role && BIND_GAP.test(line.slice(list.at(-1)!.end, next.start))
        ? next.role
        : prev?.role && BIND_GAP.test(line.slice(prev.end, list[0]!.start))
          ? prev.role
          : undefined;
    i = j;

    const singles = list.filter((t) => t.teeth.length === 1).map((t) => t.teeth[0]!);
    const ranges = list.filter((t) => t.teeth.length > 1);
    for (const r of ranges) if (r.bridge || role === 'bridge') reading.spans.push(r.teeth);
    // "bridge 35, 37": the listed teeth are the ends and whatever lies between.
    const ends = archOrder(singles);
    const listSpan = role === 'bridge' && ends.length >= 2 ? span(ends[0]!, ends.at(-1)!) : [];
    if (listSpan.length) reading.spans.push(listSpan);
    const teeth = listSpan.length ? [...listSpan, ...ranges.flatMap((r) => r.teeth)] : list.flatMap((t) => t.teeth);
    for (const fdi of teeth) {
      if (!reading.teeth.includes(fdi)) reading.teeth.push(fdi);
      if ((role === 'pontic' || role === 'abutment') && !reading.named.has(fdi)) reading.named.set(fdi, role);
    }
  }
  return reading;
}

/**
 * Rule-based prescription reader: FDI numbers (also #36, UR7, "lower left 6"),
 * material keywords, VITA shade, and a case reference from "Ref:"/"Case:"
 * only (never names). Used offline, as the LLM fallback, and to cross-check
 * the LLM's extraction.
 *
 * Bridges: "bridge 35-37", "35–37 bridge" and "13x23" are spans whose ends are
 * abutments and whose teeth between are pontics unless the text names them as
 * abutments; consecutive units are connected. A pontic named outside a span
 * ("pontic 22", "12 and 22 cantilever pontics") is connected to the run of
 * named teeth around it along the arch.
 */
export function parseRxClassical(text: string): RxParse {
  const notes: string[] = [];
  const lines = text.split(/\r?\n/);
  const teeth: number[] = [];
  const named = new Map<number, 'pontic' | 'abutment'>();
  const spans: number[][] = [];
  const restLines: string[] = [];
  for (const line of lines) {
    const reading = readLine(line);
    for (const fdi of reading.teeth) if (!teeth.includes(fdi)) teeth.push(fdi);
    for (const [fdi, role] of reading.named) if (!named.has(fdi)) named.set(fdi, role);
    spans.push(...reading.spans);
    const recognized =
      reading.teeth.length > 0 || REF.test(line) || SHADE_LABELLED.test(line) || MATERIAL_PATTERNS.some(([, re]) => re.test(line));
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

  // Units: a named role wins; otherwise the teeth inside a span are pontics.
  const interior = new Set(spans.flatMap((s) => s.slice(1, -1)));
  const isPontic = (fdi: number) => (named.get(fdi) ?? (interior.has(fdi) ? 'pontic' : 'abutment')) === 'pontic';
  const connections: FdiPair[] = spans.flatMap((s) => s.slice(1).map((fdi, k): FdiPair => [s[k]!, fdi]));
  const inCase = new Set(teeth);
  const inSpan = new Set(spans.flat());
  const covered = new Set<number>();
  for (const pontic of teeth.filter((fdi) => isPontic(fdi) && !inSpan.has(fdi))) {
    if (covered.has(pontic)) continue;
    const upper = jawOf(pontic) === 'upper';
    let [lo, hi] = [archIndex(pontic), archIndex(pontic)];
    while (lo > 0 && inCase.has(atArchIndex(upper, lo - 1))) lo--;
    while (hi < 15 && inCase.has(atArchIndex(upper, hi + 1))) hi++;
    const run = span(atArchIndex(upper, lo), atArchIndex(upper, hi));
    for (const fdi of run) covered.add(fdi);
    connections.push(...run.slice(1).map((fdi, k): FdiPair => [run[k]!, fdi]));
    const pontics = run.filter(isPontic).length;
    if (run.length > 1) notes.push(`Read ${run.join('–')} as one bridge around the pontic${pontics > 1 ? 's' : ''}; check the connectors before applying.`);
  }

  const patientRef = REF.exec(text)?.[1] ?? '';
  const orders: ToothOrder[] = teeth.map((fdi) => ({
    fdi,
    restoration: isPontic(fdi) ? 'pontic' : 'anatomic-crown',
    material,
    ...(shade ? { shade } : {}),
  }));
  const confidence =
    (teeth.length ? 0.4 : 0) + (materials.length === 1 ? 0.3 : materials.length > 1 ? 0.15 : 0) + (shade ? 0.15 : 0) + (notes.length === 0 ? 0.15 : 0);
  return {
    setup: { patientRef, teeth: orders, notes: restLines.join('\n').slice(0, 4000), connections: normalizeConnections(connections) },
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

const connectionList = (setup: CaseSetup) => normalizeConnections(setup.connections).map(([a, b]) => `${a}–${b}`).join(', ');

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
    add(`${t.fdi} restoration`, t.restoration, o.restoration);
    add(`${t.fdi} material`, t.material, o.material);
    add(`${t.fdi} shade`, t.shade, o.shade);
  }
  add('connections', connectionList(a), connectionList(b));
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
  /** validateBridges on the setup: errors block Apply (the reducer would refuse the setup). */
  issues: BridgeValidation;
}

/** The rule-based reading alone (offline, or the LLM fallback), with a remark first. */
export function classicalExtraction(text: string, why: string, classical = parseRxClassical(text)): RxExtraction {
  return {
    setup: classical.setup,
    valid: classical.valid,
    source: 'classical',
    notes: [why, ...classical.notes],
    classical,
    differences: [],
    issues: validateBridges(classical.setup),
  };
}

/**
 * Prescription → CaseSetup with the LLM (forced structured tool call). Falls
 * back to the rule-based reader when the LLM is unavailable, is the mock
 * provider, or returns nothing usable. Nothing is applied: the user confirms.
 */
export async function extractRxWithLlm(text: string, llm: (r: LlmRequest) => Promise<LlmResponse> = api.llm): Promise<RxExtraction> {
  const classical = parseRxClassical(text);
  const fallback = (why: string) => classicalExtraction(text, why, classical);
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
  // Connections must name teeth of the case; the rest of the bridge rules are checked, not repaired.
  const inCase = new Set(parsed.data.teeth.map((t) => t.fdi));
  const kept = parsed.data.connections.filter(([a, b]) => inCase.has(a) && inCase.has(b));
  const setup: CaseSetup = { ...parsed.data, connections: normalizeConnections(kept) };
  const dropped = parsed.data.connections.length - kept.length;
  const notes = dropped ? [`Dropped ${dropped} connection${dropped === 1 ? '' : 's'} to teeth that are not in the case.`] : [];
  return {
    setup,
    valid: setup.teeth.length > 0,
    source: 'llm',
    notes,
    classical,
    differences: compareRx(setup, classical.setup),
    issues: validateBridges(setup),
  };
}
