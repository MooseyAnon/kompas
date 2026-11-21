import {
  FORBIDDEN_JSON_KEYS,
  JSON_SCHEMA_LIMITS,
  jsonSchemaObjectSchema,
  type JsonSchemaNode,
  type JsonSchemaObject,
  type JsonValue,
} from '../../../shared/contracts';

export type SchemaValidation =
  | { ok: true; value: JsonValue }
  | { ok: false; reason: string };

type ArraySchema = Extract<JsonSchemaNode, { type: 'array' }>;

type ScalarSchema = Exclude<JsonSchemaNode, ArraySchema | JsonSchemaObject>;

/** A value awaiting validation; a `null` schema means "untyped, check safety". */
interface PendingNode {
  value: unknown;
  schema: JsonSchemaNode | null;
  depth: number;
}

/** Shared state for one iterative validation walk. */
interface Walk {
  pending: PendingNode[];
  seen: WeakSet<object>;
  /** Running total of string and key characters, bounded by MAX_VALUE_BYTES. */
  bytes: number;
}

/** A failure reason, or `null` when the node is acceptable. */
type NodeCheck = string | null;

const MAX_VALUE_NODES = 20_000;

const MAX_VALUE_BYTES = 200_000;

/** Validate even pre-parsed provider values; unknown properties must be traversed too. */
export function validateAgainstJsonSchema(
  value: JsonValue,
  schema: JsonSchemaObject,
): SchemaValidation {
  if (!jsonSchemaObjectSchema.safeParse(schema).success) {
    return { ok: false, reason: 'unsupported schema' };
  }

  // Iterative (not recursive) so hostile nesting cannot exhaust the stack.
  const walk: Walk = {
    pending: [{ value, schema, depth: 0 }],
    seen: new WeakSet<object>(),
    bytes: 0,
  };
  let nodes = 0;

  while (walk.pending.length) {
    const { value: node, schema: nodeSchema, depth } = walk.pending.pop()!;

    nodes += 1;
    if (nodes > MAX_VALUE_NODES || depth > JSON_SCHEMA_LIMITS.depth) {
      return { ok: false, reason: 'response complexity limit' };
    }

    const isNullableNull = node === null && Array.isArray(nodeSchema?.type);
    if (isNullableNull) {
      continue;
    }

    const failure = checkNode(node, nodeSchema, depth, walk);
    if (failure) {
      return { ok: false, reason: failure };
    }

    if (walk.bytes > MAX_VALUE_BYTES) {
      return { ok: false, reason: 'response size limit' };
    }
  }

  return { ok: true, value };
}

/** Parse untrusted JSON text and reject prototype-polluting keys at every depth. */
export function safeParseJson(text: string): JsonValue | undefined {
  if (text.length > MAX_VALUE_BYTES) {
    return undefined;
  }

  try {
    return JSON.parse(text, (key, val) => {
      if (FORBIDDEN_JSON_KEYS.includes(key)) {
        throw new Error('forbidden key');
      }

      return val as JsonValue;
    }) as JsonValue;
  } catch {
    return undefined;
  }
}

function checkNode(
  value: unknown,
  schema: JsonSchemaNode | null,
  depth: number,
  walk: Walk,
): NodeCheck {
  if (schema === null) {
    return checkUntyped(value, depth, walk);
  }

  if (schema.type === 'object') {
    return checkObject(value, schema, depth, walk);
  }

  if (schema.type === 'array') {
    return checkArray(value, schema, depth, walk);
  }

  return checkScalar(value, schema, walk);
}

/** Safety-only checks for values not described by the schema. */
function checkUntyped(value: unknown, depth: number, walk: Walk): NodeCheck {
  if (value && typeof value === 'object') {
    if (walk.seen.has(value)) {
      return 'cyclic value';
    }

    walk.seen.add(value);
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return 'expected plain object';
    }

    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEYS.includes(key)) {
        return 'forbidden property key';
      }

      walk.bytes += key.length;
      walk.pending.push({ value: child, schema: null, depth: depth + 1 });
    }

    return null;
  }

  if (typeof value === 'string') {
    walk.bytes += value.length;
    return null;
  }

  const isJsonPrimitive =
    value === null ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean';

  return isJsonPrimitive ? null : 'invalid JSON value';
}

function checkObject(
  value: unknown,
  schema: JsonSchemaObject,
  depth: number,
  walk: Walk,
): NodeCheck {
  const isFreshPlainObject =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isPlainObject(value) &&
    !walk.seen.has(value);
  if (!isFreshPlainObject) {
    return 'expected plain object';
  }

  walk.seen.add(value);
  const obj = value as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    walk.bytes += key.length;
    if (FORBIDDEN_JSON_KEYS.includes(key)) {
      return 'forbidden property key';
    }

    const isKnown = Object.hasOwn(schema.properties, key);
    if (!isKnown && schema.additionalProperties === false) {
      return 'unexpected property';
    }

    // Unknown fields still require complete safety/size validation.
    walk.pending.push({
      value: obj[key],
      schema: isKnown ? schema.properties[key] : null,
      depth: depth + 1,
    });
  }

  if (schema.required?.some((key) => !Object.hasOwn(obj, key))) {
    return 'missing required property';
  }

  return null;
}

function checkArray(
  value: unknown,
  schema: ArraySchema,
  depth: number,
  walk: Walk,
): NodeCheck {
  const isBoundedArray =
    Array.isArray(value) &&
    (schema.maxItems === undefined || value.length <= schema.maxItems);
  if (!isBoundedArray) {
    return 'expected bounded array';
  }

  if (walk.seen.has(value)) {
    return 'cyclic value';
  }

  walk.seen.add(value);
  for (const child of value) {
    walk.pending.push({ value: child, schema: schema.items, depth: depth + 1 });
  }

  return null;
}

function checkScalar(
  value: unknown,
  schema: ScalarSchema,
  walk: Walk,
): NodeCheck {
  // A nullable string whose value is non-null is validated as a string.
  const type = Array.isArray(schema.type) ? 'string' : schema.type;
  if (!matchesScalarType(value, type)) {
    return 'wrong scalar type';
  }

  if (typeof value === 'string') {
    walk.bytes += value.length;

    const tooShort = value.length < (schema.minLength ?? 0);
    const tooLong = value.length > (schema.maxLength ?? MAX_VALUE_BYTES);
    if (tooShort || tooLong) {
      return 'string length';
    }
  }

  if (
    schema.enum &&
    !schema.enum.includes(value as string | number | boolean)
  ) {
    return 'value not in enum';
  }

  return null;
}

function matchesScalarType(
  value: unknown,
  type: 'string' | 'number' | 'integer' | 'boolean',
): boolean {
  if (type === 'string') {
    return typeof value === 'string';
  }

  if (type === 'boolean') {
    return typeof value === 'boolean';
  }

  const isFiniteNumber = typeof value === 'number' && Number.isFinite(value);

  return isFiniteNumber && (type !== 'integer' || Number.isInteger(value));
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}
