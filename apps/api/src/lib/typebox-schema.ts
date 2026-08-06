import { Type, type TSchema } from "@earendil-works/pi-ai";

/**
 * JSON Schema -> typebox, because Pi tools take typebox and everything that
 * feeds them speaks JSON Schema.
 *
 * This lived inside `pi.service.ts` when its only inputs were our own
 * hand-written tool definitions, which are flat. MCP servers publish arbitrary
 * `inputSchema`s — nested objects, arrays of objects, unions, enums of numbers
 * — so the conversion moved here, gained the recursive cases, and gained tests.
 *
 * Unknown constructs degrade to `Type.Any()` rather than throwing. A tool with
 * one exotic parameter should still be callable; refusing to convert it would
 * remove the whole tool over a field the model may never set.
 */

/** Convert a JSON-Schema-ish `parameters` object into a typebox object schema. */
export function jsonSchemaToTypebox(parameters: Record<string, unknown> | undefined): TSchema {
  const schema = parameters ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const props: Record<string, TSchema> = {};

  for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, any>)) {
    let converted = jsonTypeToTypebox(value);
    if (!required.has(key)) converted = Type.Optional(converted);
    props[key] = converted;
  }

  return Type.Object(props);
}

/** Convert one JSON Schema node. */
export function jsonTypeToTypebox(node: any): TSchema {
  if (!node || typeof node !== "object") return Type.Any();

  // `enum` is checked before `type`: a schema may give both, and the enum is
  // the stricter statement of the two.
  if (Array.isArray(node.enum) && node.enum.length) {
    return unionOfLiterals(node.enum);
  }

  // `anyOf` / `oneOf` are how a nullable or multi-typed field is usually
  // expressed. Collapsing them to Any would lose the shape of every branch.
  const branches = node.anyOf ?? node.oneOf;
  if (Array.isArray(branches) && branches.length) {
    const converted = branches.map((b: any) => jsonTypeToTypebox(b));
    return converted.length === 1 ? converted[0]! : Type.Union(converted);
  }

  // A `type` array (e.g. ["string", "null"]) is the other spelling of a union.
  if (Array.isArray(node.type)) {
    const converted = node.type.map((t: string) => jsonTypeToTypebox({ ...node, type: t }));
    return converted.length === 1 ? converted[0]! : Type.Union(converted);
  }

  switch (node.type) {
    case "string":
      return Type.String();
    case "number":
      return Type.Number();
    case "integer":
      return Type.Integer();
    case "boolean":
      return Type.Boolean();
    case "null":
      return Type.Null();
    case "array":
      return Type.Array(node.items ? jsonTypeToTypebox(node.items) : Type.Any());
    case "object":
      // An object with no declared properties means "any object" — most often a
      // free-form map. `Type.Object({})` would say the opposite: no fields.
      if (!node.properties || !Object.keys(node.properties).length) return Type.Any();
      return jsonSchemaToTypebox(node);
    default:
      return Type.Any();
  }
}

/**
 * Build a union of literals from an enum, skipping values typebox cannot
 * express as a literal (objects, arrays, null).
 */
function unionOfLiterals(values: unknown[]): TSchema {
  const literals = values
    .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map((v) => Type.Literal(v as string | number | boolean));
  if (!literals.length) return Type.Any();
  return literals.length === 1 ? literals[0]! : Type.Union(literals);
}
