/**
 * A small structural JSON Schema check for tool inputs: type, enum, const, properties, required,
 * additionalProperties, items, numeric and length bounds, anyOf/oneOf/allOf and local $ref. Other keywords are
 * ignored, so the check is lenient rather than complete. Returns one message per problem, empty when the value fits.
 */
export type JsonSchema = boolean | { [key: string]: unknown };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, type: string): boolean {
  const actual = typeOf(v);
  return actual === type || (type === 'number' && actual === 'integer');
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith('#')) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    if (!isObj(node)) return undefined;
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return typeof node === 'boolean' || isObj(node) ? node : undefined;
}

export function checkSchema(value: unknown, schema: JsonSchema, path = 'input', root: JsonSchema = schema): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: not allowed`];
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    return target === undefined ? [] : checkSchema(value, target, path, root);
  }
  const errors: string[] = [];
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : [];
  if (types.length && !types.some((t) => typeMatches(value, t))) {
    return [`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      errors.push(`${path}: must be < ${schema.exclusiveMaximum}`);
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: too long`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    const items = schema.items;
    if (typeof items === 'boolean' || isObj(items)) {
      value.forEach((item, i) => errors.push(...checkSchema(item, items, `${path}[${i}]`, root)));
    }
  }
  if (isObj(value)) {
    const props = isObj(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = props[key];
      if (sub !== undefined) errors.push(...checkSchema(v, sub, `${path}.${key}`, root));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown property`);
      else if (isObj(schema.additionalProperties)) {
        errors.push(...checkSchema(v, schema.additionalProperties, `${path}.${key}`, root));
      }
    }
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && !branches.some((b: JsonSchema) => checkSchema(value, b, path, root).length === 0)) {
      errors.push(`${path}: matches none of the allowed shapes`);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const b of schema.allOf as JsonSchema[]) errors.push(...checkSchema(value, b, path, root));
  }
  return errors;
}
