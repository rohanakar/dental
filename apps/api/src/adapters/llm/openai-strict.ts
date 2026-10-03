/**
 * Normalise a JSON Schema (as produced by zod v4's z.toJSONSchema) for
 * OpenAI function calling in strict mode:
 * - every object has `additionalProperties: false`
 * - every property is listed in `required`; originally-optional properties
 *   become nullable instead
 * - keywords strict mode does not accept are dropped (the browser validates
 *   tool calls with the original zod schema anyway)
 */

type Json = Record<string, unknown>;

const KEEP = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  '$defs',
  '$ref',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
  'minItems',
  'maxItems',
]);

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function makeNullable(schema: Json): Json {
  if (Array.isArray(schema.anyOf)) {
    const hasNull = (schema.anyOf as Json[]).some((s) => s.type === 'null');
    return hasNull ? schema : { ...schema, anyOf: [...(schema.anyOf as Json[]), { type: 'null' }] };
  }
  if (typeof schema.type === 'string') {
    const next: Json = { ...schema, type: [schema.type, 'null'] };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) next.enum = [...schema.enum, null];
    return next;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.includes('null') ? schema : { ...schema, type: [...schema.type, 'null'] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

export function toOpenAiStrictSchema(input: unknown): Json {
  if (!isObject(input)) return {};
  const out: Json = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KEEP.has(key)) continue;
    out[key] = value;
  }

  if (isObject(out.$defs)) {
    out.$defs = Object.fromEntries(Object.entries(out.$defs).map(([k, v]) => [k, toOpenAiStrictSchema(v)]));
  }
  if (Array.isArray(out.anyOf)) out.anyOf = (out.anyOf as unknown[]).map(toOpenAiStrictSchema);
  if (isObject(out.items)) out.items = toOpenAiStrictSchema(out.items);

  const isObjectType = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object')) || isObject(out.properties);
  if (isObjectType) {
    const properties = isObject(out.properties) ? out.properties : {};
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    const normalised: Json = {};
    for (const [name, prop] of Object.entries(properties)) {
      const strict = toOpenAiStrictSchema(prop);
      normalised[name] = required.has(name) ? strict : makeNullable(strict);
    }
    out.type = out.type ?? 'object';
    out.properties = normalised;
    out.required = Object.keys(normalised);
    out.additionalProperties = false;
  }
  return out;
}
