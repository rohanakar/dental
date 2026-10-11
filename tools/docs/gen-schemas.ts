/**
 * Generates documentation/reference/schemas.html from the zod schemas in
 * packages/shared. Run: corepack pnpm --filter @dcad/docs-tools gen
 *
 * Descriptions come from `.describe()` on the schemas and from the JSDoc
 * comments in the shared source files, so the page stays in sync with code.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as apiMod from '../../packages/shared/src/api';
import * as caseMod from '../../packages/shared/src/case';
import * as commandsMod from '../../packages/shared/src/commands';
import * as designMod from '../../packages/shared/src/design';
import * as eventsMod from '../../packages/shared/src/events';
import * as geometryMod from '../../packages/shared/src/geometry';
import * as llmMod from '../../packages/shared/src/llm';
import * as proposerMod from '../../packages/shared/src/proposer';
import * as toolsMod from '../../packages/shared/src/tools';

type Json = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const sharedSrc = resolve(repo, 'packages/shared/src');
const outFile = resolve(repo, 'documentation/reference/schemas.html');

interface SourceFile {
  file: string;
  title: string;
  intro: string;
  mod: Record<string, unknown>;
}

const FILES: SourceFile[] = [
  {
    file: 'geometry',
    title: 'Geometry primitives',
    intro: 'Vectors, poses and content-addressed mesh references. All lengths are millimetres.',
    mod: geometryMod,
  },
  {
    file: 'case',
    title: 'Case setup & materials',
    intro: 'Tooth numbering, the order (what to make, in which material) and per-tooth design parameters with material presets.',
    mod: caseMod,
  },
  {
    file: 'design',
    title: 'Design document',
    intro:
      'The single source of truth for a design. The web app keeps immutable snapshots of it for undo; the API stores saved versions of it.',
    mod: designMod,
  },
  {
    file: 'commands',
    title: 'Commands',
    intro:
      'Every change to a DesignDocument is one of these commands. Document commands set state directly; clinical commands are tooth-local and are also exposed to the LLM agent as tools.',
    mod: commandsMod,
  },
  {
    file: 'proposer',
    title: 'Proposer contract',
    intro: 'The AI extension point: one proposer per design step, run as an async job in the browser or on a server.',
    mod: proposerMod,
  },
  {
    file: 'events',
    title: 'Proposal events',
    intro: 'What the system proposed and what the user accepted, stored as artifacts so each event can become a training example.',
    mod: eventsMod,
  },
  {
    file: 'llm',
    title: 'LLM wire format',
    intro: 'Provider-agnostic messages between the browser (which runs the agent loop) and the API proxy (which holds the keys).',
    mod: llmMod,
  },
  {
    file: 'tools',
    title: 'Agent tools',
    intro: 'Tool definitions the LLM agent receives. Action tools are generated from the clinical command schemas; query tools only read metrics.',
    mod: toolsMod,
  },
  {
    file: 'api',
    title: 'REST DTOs',
    intro: 'Request and response bodies of the HTTP API shared by apps/api and apps/web.',
    mod: apiMod,
  },
];

/**
 * A few JSDoc comments in the source sit above the first export of a group
 * but describe the group (or the whole file). Re-home them here rather than
 * mis-describing the export they happen to precede.
 */
const DOC_MOVES: Record<string, { to: string; replacement: string }> = {
  Artifact: {
    to: 'ProposalEvent',
    replacement: 'A stored artifact: either inline JSON (margins, axes, poses) or a content-addressed mesh reference.',
  },
  TemplateCrown: {
    to: 'Crown',
    replacement: 'A library template crown deformed onto the margin; its pose is in the tooth frame.',
  },
  QUERY_TOOLS: {
    to: '@file:tools',
    replacement: 'Read-only agent tools: the agent queries deterministic metrics and views through these.',
  },
  LlmTextPart: {
    to: '@file:llm',
    replacement: 'Plain text content.',
  },
  Vec3: {
    to: '@file:geometry',
    replacement: 'A 3D point or direction [x, y, z] in millimetres.',
  },
  CaseStatus: {
    to: '@file:api',
    replacement: 'Lifecycle state of a case.',
  },
};

// ---------------------------------------------------------------- source parsing

interface ParsedSource {
  order: string[];
  jsdoc: Map<string, string>;
  fieldDocs: Map<string, Map<string, string>>;
  signatures: Map<string, string>;
  fileIntro?: string;
}

const cleanJsDoc = (raw: string): string =>
  raw
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

function parseSource(file: string): ParsedSource {
  const text = readFileSync(resolve(sharedSrc, `${file}.ts`), 'utf8');
  const exportRe = /^export (?:const|function) ([A-Za-z_$][\w$]*)/gm;
  const hits: { name: string; index: number }[] = [];
  for (let m = exportRe.exec(text); m; m = exportRe.exec(text)) hits.push({ name: m[1]!, index: m.index });

  const parsed: ParsedSource = { order: [], jsdoc: new Map(), fieldDocs: new Map(), signatures: new Map() };
  // A file header: the first JSDoc, located before the first export and not attached to it.
  const firstDoc = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/(\s*)(export )?/.exec(text);
  if (firstDoc && !firstDoc[3] && firstDoc.index < (hits[0]?.index ?? Infinity)) parsed.fileIntro = cleanJsDoc(firstDoc[1]!);
  hits.forEach((hit, i) => {
    parsed.order.push(hit.name);
    const before = text.slice(0, hit.index);
    const doc = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*$/.exec(before);
    if (doc) parsed.jsdoc.set(hit.name, cleanJsDoc(doc[1]!));

    const block = text.slice(hit.index, hits[i + 1]?.index ?? text.length);
    const fields = new Map<string, string>();
    const fieldRe = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*([A-Za-z_$][\w$]*)\s*:/g;
    for (let f = fieldRe.exec(block); f; f = fieldRe.exec(block)) fields.set(f[2]!, cleanJsDoc(f[1]!));
    parsed.fieldDocs.set(hit.name, fields);

    const fn = /^export function \w+(\([^)]*\)\s*:\s*[^{]+)\{/.exec(block);
    const arrow = /^export const \w+\s*=\s*(\([^)]*\)\s*:\s*[^=]+)=>/.exec(block);
    const sig = fn?.[1] ?? arrow?.[1];
    if (sig) parsed.signatures.set(hit.name, sig.replace(/\s+/g, ' ').trim());
  });
  return parsed;
}

// ---------------------------------------------------------------- schema helpers

const isZod = (v: unknown): v is z.ZodType => v instanceof z.ZodType;

function toJson(schema: z.ZodType): Json {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return rest;
}

/** Canonical form for structural matching: drop descriptions/defaults, sort keys. */
function canonical(value: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: Json = {};
      for (const key of Object.keys(v as Json).sort()) {
        if (key === 'description' || key === 'default') continue;
        out[key] = strip((v as Json)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(value));
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

interface NamedSchema {
  name: string;
  file: string;
  schema: z.ZodType;
  json: Json;
}

const named: NamedSchema[] = [];
const byCanonical = new Map<string, string>();
const parsedByFile = new Map<string, ParsedSource>();

for (const f of FILES) {
  const parsed = parseSource(f.file);
  parsedByFile.set(f.file, parsed);
  for (const name of parsed.order) {
    const value = f.mod[name];
    if (!isZod(value)) continue;
    const json = toJson(value);
    named.push({ name, file: f.file, schema: value, json });
    const key = canonical(json);
    const trivial = key === '{}' || /^\{"type":"(string|number|integer|boolean)"\}$/.test(key);
    if (!trivial && !byCanonical.has(key)) byCanonical.set(key, name);
  }
}

for (const [from, move] of Object.entries(DOC_MOVES)) {
  for (const f of FILES) {
    const parsed = parsedByFile.get(f.file)!;
    const doc = parsed.jsdoc.get(from);
    if (!doc) continue;
    if (move.to.startsWith('@file:')) parsed.fileIntro = doc;
    else parsed.jsdoc.set(move.to, doc);
    parsed.jsdoc.set(from, move.replacement);
  }
}

// ---------------------------------------------------------------- HTML rendering

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const code = (s: string): string => `<code>${esc(s)}</code>`;
const anchor = (name: string): string => `schema-${name}`;
const link = (name: string): string => `<a href="#${anchor(name)}">${code(name)}</a>`;

/** File whose schemas are being rendered; see namedMatch. */
let renderingFile = '';

/**
 * Link a structurally identical named schema. Discriminated variants (objects
 * with a const field) only match within the same file: e.g. the mesh variant
 * of events.Artifact has the same shape as design.MeshCrown but is unrelated.
 */
function namedMatch(json: unknown, self?: string): string | undefined {
  const hit = byCanonical.get(canonical(json));
  if (!hit || hit === self) return undefined;
  const target = named.find((n) => n.name === hit)!;
  return unionMembers.has(hit) && target.file !== renderingFile ? undefined : hit;
}

/** Named schemas that are members of a named union (discriminated variants). */
const unionMembers = new Set<string>();
for (const n of named) {
  const union = (n.json.oneOf ?? n.json.anyOf) as unknown[] | undefined;
  if (!Array.isArray(union)) continue;
  for (const member of union) {
    const hit = byCanonical.get(canonical(member));
    if (hit) unionMembers.add(hit);
  }
}

function typeHtml(s: unknown, self?: string): string {
  if (!isObj(s) || Object.keys(s).filter((k) => k !== 'description' && k !== 'default').length === 0) return code('unknown');
  const hit = namedMatch(s, self);
  if (hit) return link(hit);
  if ('const' in s) return code(JSON.stringify(s.const));
  if (Array.isArray(s.enum)) return s.enum.map((v) => code(JSON.stringify(v))).join(' | ');
  const union = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (Array.isArray(union)) return union.map((u) => typeHtml(u)).join(' | ');
  const type = s.type;
  if (type === 'array') {
    if (Array.isArray(s.prefixItems)) return `[${(s.prefixItems as unknown[]).map((p) => typeHtml(p)).join(', ')}]`;
    const item = s.items;
    const inner = typeHtml(item);
    return isObj(item) && (item.oneOf || item.anyOf) && !namedMatch(item) ? `(${inner})[]` : `${inner}[]`;
  }
  if (type === 'object') {
    if (isObj(s.properties)) return code('object');
    const valueType = isObj(s.additionalProperties) ? typeHtml(s.additionalProperties) : code('unknown');
    const keys = isObj(s.propertyNames) ? typeHtml(s.propertyNames) : code('string');
    return `Record&lt;${keys}, ${valueType}&gt;`;
  }
  if (Array.isArray(type)) return type.map((t) => code(String(t))).join(' | ');
  return code(String(type));
}

function constraintsHtml(s: unknown): string {
  if (!isObj(s)) return '';
  const parts: string[] = [];
  const num = (k: string, label: string) => {
    const v = s[k];
    if (typeof v === 'number' && Math.abs(v) !== MAX_SAFE) parts.push(`${label} ${v}`);
  };
  num('minimum', '≥');
  num('exclusiveMinimum', '>');
  num('maximum', '≤');
  num('exclusiveMaximum', '<');
  if (typeof s.minLength === 'number') parts.push(`length ≥ ${s.minLength}`);
  if (typeof s.maxLength === 'number') parts.push(`length ≤ ${s.maxLength}`);
  if (typeof s.pattern === 'string') parts.push(`pattern ${code(s.pattern)}`);
  if (typeof s.format === 'string') parts.push(`format ${s.format}`);
  if (!Array.isArray(s.prefixItems)) {
    if (typeof s.minItems === 'number' && s.minItems > 0) parts.push(`items ≥ ${s.minItems}`);
    if (typeof s.maxItems === 'number') parts.push(`items ≤ ${s.maxItems}`);
  }
  if ('default' in s) parts.push(`default ${code(JSON.stringify(s.default))}`);
  return parts.join('<br>');
}

interface Row {
  name: string;
  type: string;
  required: boolean;
  constraints: string;
  description: string;
}

/** Field comments only come from the schema's own source block (same names mean different things elsewhere). */
function fieldDoc(field: string, owner: string, file: string): string {
  return parsedByFile.get(file)?.fieldDocs.get(owner)?.get(field) ?? '';
}

function objectRows(s: Json, prefix: string, owner: string, file: string, depth: number): Row[] {
  const rows: Row[] = [];
  const props = isObj(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  for (const [name, prop] of Object.entries(props)) {
    const p = isObj(prop) ? prop : {};
    rows.push({
      name: prefix + name,
      type: typeHtml(p),
      required: required.has(name),
      constraints: constraintsHtml(p),
      description: typeof p.description === 'string' ? p.description : fieldDoc(name, owner, file),
    });
    if (depth >= 3 || namedMatch(p)) continue;
    if (isObj(p.properties)) rows.push(...objectRows(p, `${prefix}${name}.`, owner, file, depth + 1));
    else if (p.type === 'array' && isObj(p.items) && isObj(p.items.properties) && !namedMatch(p.items))
      rows.push(...objectRows(p.items, `${prefix}${name}[].`, owner, file, depth + 1));
    else if (isObj(p.additionalProperties) && isObj(p.additionalProperties.properties) && !namedMatch(p.additionalProperties))
      rows.push(...objectRows(p.additionalProperties, `${prefix}${name}.‹key›.`, owner, file, depth + 1));
  }
  return rows;
}

function rowsTable(rows: Row[]): string {
  if (rows.length === 0) return '<p><em>No fields.</em></p>';
  const body = rows
    .map(
      (r) =>
        `<tr><td>${code(r.name)}</td><td>${r.type}</td><td>${r.required ? 'yes' : 'no'}</td><td>${r.constraints}</td><td>${esc(r.description)}</td></tr>`,
    )
    .join('\n');
  return `<div class="table-wrap"><table>
<thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Constraints</th><th>Description</th></tr></thead>
<tbody>
${body}
</tbody></table></div>`;
}

function variantLabel(v: Json): string {
  const props = isObj(v.properties) ? v.properties : {};
  for (const [k, p] of Object.entries(props)) {
    if (isObj(p) && 'const' in p) return `${k}: ${JSON.stringify(p.const)}`;
  }
  return 'variant';
}

function schemaBody(n: NamedSchema): string {
  const s = n.json;
  const union = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (isObj(s.properties)) return rowsTable(objectRows(s, '', n.name, n.file, 0));
  if (Array.isArray(union)) {
    const items = union.map((v) => {
      if (!isObj(v)) return `<li>${code('unknown')}</li>`;
      const hit = namedMatch(v, n.name);
      if (hit) return `<li>${link(hit)}</li>`;
      if (isObj(v.properties))
        return `<li>${code(variantLabel(v))}${rowsTable(objectRows(v, '', n.name, n.file, 0))}</li>`;
      return `<li>${typeHtml(v)}</li>`;
    });
    return `<p><strong>One of</strong> (discriminated union):</p><ul>${items.join('')}</ul>`;
  }
  if (Array.isArray(s.enum)) return `<p><strong>Values:</strong> ${s.enum.map((v) => code(String(v))).join(' ')}</p>`;
  const c = constraintsHtml(s);
  return `<dl class="kv"><dt>Type</dt><dd>${typeHtml(s, n.name)}</dd>${c ? `<dt>Constraints</dt><dd>${c}</dd>` : ''}</dl>`;
}

function kindBadge(n: NamedSchema): string {
  const s = n.json;
  if (s.oneOf || s.anyOf) return 'union';
  if (Array.isArray(s.enum)) return 'enum';
  if (isObj(s.properties)) return 'object';
  return 'type';
}

function renderSchema(n: NamedSchema): string {
  const parsed = parsedByFile.get(n.file)!;
  const description = n.schema.description ?? parsed.jsdoc.get(n.name) ?? '';
  return `
<h3 id="${anchor(n.name)}">${esc(n.name)}</h3>
<p class="eyebrow"><span class="badge depth">${kindBadge(n)}</span> <span>${code(`packages/shared/src/${n.file}.ts`)}</span></p>
${description ? `<p>${esc(description)}</p>` : ''}
${schemaBody(n)}
<details class="deep"><summary>Raw JSON Schema (input)</summary><div class="body"><pre><code>${esc(
    JSON.stringify(n.json, null, 2),
  )}</code></pre></div></details>`;
}

function renderHelpers(f: SourceFile): string {
  const parsed = parsedByFile.get(f.file)!;
  const rows: string[] = [];
  const constants: string[] = [];
  for (const name of parsed.order) {
    const value = f.mod[name];
    if (isZod(value)) continue;
    const doc = parsed.jsdoc.get(name) ?? '';
    if (typeof value === 'function') {
      const sig = parsed.signatures.get(name) ?? '(…)';
      rows.push(`<tr><td>${code(name + sig)}</td><td>${esc(doc)}</td></tr>`);
    } else if (name !== 'MATERIAL_PRESETS') {
      constants.push(`<tr><td>${code(name)}</td><td>${constantValue(value)}</td><td>${esc(doc)}</td></tr>`);
    }
  }
  let html = '';
  if (constants.length)
    html += `<h4>Constants</h4><div class="table-wrap"><table><thead><tr><th>Name</th><th>Value</th><th>Description</th></tr></thead><tbody>${constants.join('')}</tbody></table></div>`;
  if (rows.length)
    html += `<h4>Helper functions</h4><div class="table-wrap"><table><thead><tr><th>Signature</th><th>Description</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  return html;
}

function constantValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (isZod(v)) {
          const hit = named.find((n) => n.schema === v);
          return hit ? link(hit.name) : code('schema');
        }
        return code(String(v));
      })
      .join(' ');
  }
  if (isObj(value)) {
    return Object.entries(value)
      .map(([k, v]) => (isZod(v) ? code(k) : `${code(k)}: ${code(JSON.stringify(v))}`))
      .join(' ');
  }
  return code(JSON.stringify(value));
}

function presetsTable(): string {
  const presets = caseMod.MATERIAL_PRESETS;
  const materials = Object.keys(presets) as (keyof typeof presets)[];
  const params = Object.keys(presets[materials[0]!]) as (keyof (typeof presets)[keyof typeof presets])[];
  const fieldDocs = parsedByFile.get('case')!.fieldDocs.get('DesignParams')!;
  const head = `<tr><th>Parameter (mm)</th>${materials.map((m) => `<th>${esc(m)}</th>`).join('')}<th>Meaning</th></tr>`;
  const body = params
    .map(
      (p) =>
        `<tr><td>${code(p)}</td>${materials.map((m) => `<td>${presets[m][p]}</td>`).join('')}<td>${esc(fieldDocs.get(p) ?? '')}</td></tr>`,
    )
    .join('');
  return `<h3 id="material-presets">MATERIAL_PRESETS</h3>
<p>Default design parameters loaded when a material is chosen. Values are starting points; the user can change them per tooth.</p>
<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function toolDefsTable(): string {
  const defs = toolsMod.agentToolDefs();
  const rows = defs
    .map((d) => {
      const props = isObj(d.inputSchema.properties) ? d.inputSchema.properties : {};
      const req = new Set(Array.isArray(d.inputSchema.required) ? (d.inputSchema.required as string[]) : []);
      const args = Object.entries(props)
        .map(([k, p]) => {
          const c = constraintsHtml(p).replace(/<br>/g, ', ');
          return `${code(k)}${req.has(k) ? '' : '?'}: ${typeHtml(p)}${c ? ` <small>(${c})</small>` : ''}`;
        })
        .join('<br>');
      const kind = toolsMod.isQueryTool(d.name) ? 'query' : 'action';
      return `<tr><td>${code(d.name)}</td><td>${kind}</td><td>${args || '<em>none</em>'}</td><td>${esc(d.description)}</td></tr>`;
    })
    .join('\n');
  return `<h3 id="generated-tool-definitions">Generated tool definitions</h3>
<p>Output of ${code('agentToolDefs()')} — exactly what the browser sends to the LLM proxy. Action tools map back to commands with ${code('commandFromToolCall()')}, which validates the arguments with the original zod schema. For OpenAI, the API additionally normalises these schemas to strict mode (every property required, optional ones nullable, ${code('additionalProperties: false')}).</p>
<div class="table-wrap"><table><thead><tr><th>Tool</th><th>Kind</th><th>Arguments</th><th>Description</th></tr></thead><tbody>
${rows}
</tbody></table></div>
<details class="deep"><summary>Raw tool definitions (JSON)</summary><div class="body"><pre><code>${esc(
    JSON.stringify(defs, null, 2),
  )}</code></pre></div></details>`;
}

function renderSection(f: SourceFile): string {
  renderingFile = f.file;
  const parsed = parsedByFile.get(f.file)!;
  const schemas = named.filter((n) => n.file === f.file);
  const parts = [
    `<h2 id="file-${f.file}">${esc(f.title)}</h2>`,
    `<p>${esc(f.intro)} Source: ${code(`packages/shared/src/${f.file}.ts`)}.</p>`,
  ];
  if (parsed.fileIntro) parts.push(`<div class="callout note"><strong>From the source</strong>${esc(parsed.fileIntro)}</div>`);
  if (f.file === 'tools') parts.push(toolDefsTable());
  for (const n of schemas) parts.push(renderSchema(n));
  if (f.file === 'case') parts.push(presetsTable());
  const helpers = renderHelpers(f);
  if (helpers) parts.push(`<h3 id="helpers-${f.file}">Constants &amp; helpers in ${esc(f.file)}.ts</h3>${helpers}`);
  return parts.join('\n');
}

// ---------------------------------------------------------------- page

const today = new Date().toISOString().slice(0, 10);
const schemaCount = named.length;
const toolCount = toolsMod.agentToolDefs().length;

const overviewRows = FILES.map((f) => {
  const names = named.filter((n) => n.file === f.file).map((n) => link(n.name));
  if (f.file === 'tools') names.push(`<a href="#generated-tool-definitions">${toolCount} generated tool definitions</a>`);
  return `<tr><td><a href="#file-${f.file}">${esc(f.title)}</a></td><td>${code(`${f.file}.ts`)}</td><td>${names.join(' ')}</td></tr>`;
}).join('\n');

const html = `<!doctype html>
<!--
  GENERATED FILE — do not edit by hand.
  Source: packages/shared/src/*.ts   Generator: tools/docs/gen-schemas.ts
  Regenerate: COREPACK_INTEGRITY_KEYS=0 corepack pnpm --filter @dcad/docs-tools gen
-->
<html lang="en" data-root="..">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Data contracts · DentalCAD docs</title>
  <meta name="description" content="Generated reference for every zod schema in packages/shared: the design document, commands, proposer contract, LLM wire format, agent tools and REST DTOs.">
  <link rel="stylesheet" href="../assets/docs.css">
</head>
<body data-page="reference/schemas.html">
  <header class="topbar">
    <button class="icon-btn menu-btn" id="menu-toggle" aria-expanded="false" aria-controls="sidebar">☰</button>
    <a class="brand" href="../index.html">DentalCAD <small>design docs</small></a>
    <span class="spacer"></span>
    <button class="icon-btn" id="theme-toggle" type="button">☾ Dark</button>
  </header>

  <div class="layout">
    <nav class="sidebar" id="sidebar" aria-label="Documentation"></nav>

    <main>
      <div class="eyebrow"><span class="badge depth">Ref · Reference</span> <span>For: engineers (web, API, ML)</span> <span class="badge done">Built · Day 1</span></div>
      <h1>Data contracts</h1>
      <p class="lede">Every schema shared by the web app, the API and future model services, generated from the zod definitions in ${code(
        'packages/shared',
      )}. If this page and the code disagree, the code wins — regenerate the page.</p>

      <div class="tldr">
        <strong>In short</strong>
        <ul>
          <li>${schemaCount} schemas in 9 source files; ${toolCount} LLM agent tools are generated from them.</li>
          <li>zod v4 is the single source of truth: runtime validation in browser and API, JSON Schema for LLM tools, and later pydantic models for Python ML services.</li>
          <li>All geometry is in millimetres; meshes are referenced by sha256 with explicit units and frame, never by face index.</li>
          <li>Field tables show the <em>input</em> view: "Required: no" fields may be omitted (some then take a default).</li>
        </ul>
      </div>

      <h2 id="index">Index</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Section</th><th>File</th><th>Schemas</th></tr></thead>
        <tbody>
${overviewRows}
        </tbody>
      </table></div>
      <div class="callout note"><strong>How to read the tables</strong>Types that match another named schema link to it. Nested anonymous objects are flattened with dotted paths (${code(
        'inputSnapshot.params',
      )}), arrays with ${code('[]')} and record values with ${code('.‹key›.')}. Numeric bounds, patterns and defaults appear under Constraints. Refinements that JSON Schema cannot express (for example the FDI quadrant/position rule) are enforced by zod at runtime but not shown here.</div>

${FILES.map(renderSection).join('\n\n')}

      <nav class="page-nav" id="page-nav" aria-label="Previous and next page"></nav>
      <footer class="page-footer">Generated ${today} from ${code('packages/shared/src')} by ${code(
        'tools/docs/gen-schemas.ts',
      )}. Regenerate with ${code('corepack pnpm --filter @dcad/docs-tools gen')}.</footer>
    </main>

    <aside class="toc" id="toc" aria-label="On this page"></aside>
  </div>
  <script src="../assets/docs.js"></script>
</body>
</html>
`;

writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${schemaCount} schemas, ${toolCount} tools, ${(html.length / 1024).toFixed(0)} KB)`);
