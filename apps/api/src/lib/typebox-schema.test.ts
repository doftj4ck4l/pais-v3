import { describe, expect, it } from "bun:test";
import { jsonSchemaToTypebox, jsonTypeToTypebox } from "./typebox-schema";

/**
 * Asserts on the emitted typebox schema as plain JSON. Typebox schemas *are*
 * JSON Schema objects at runtime, so this checks the real output rather than a
 * stand-in.
 */

describe("jsonSchemaToTypebox", () => {
  it("keeps required and optional properties apart", () => {
    const out: any = jsonSchemaToTypebox({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(out.required).toEqual(["a"]);
    expect(out.properties.a.type).toBe("string");
    expect(out.properties.b.type).toBe("number");
  });

  it("handles an empty or missing schema", () => {
    expect((jsonSchemaToTypebox(undefined) as any).type).toBe("object");
    expect((jsonSchemaToTypebox({}) as any).type).toBe("object");
  });

  it("converts a nested object rather than flattening it to any", () => {
    const out: any = jsonSchemaToTypebox({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { state: { type: "string" }, limit: { type: "integer" } },
          required: ["state"],
        },
      },
      required: ["filter"],
    });
    expect(out.properties.filter.type).toBe("object");
    expect(out.properties.filter.properties.state.type).toBe("string");
    expect(out.properties.filter.properties.limit.type).toBe("integer");
    expect(out.properties.filter.required).toEqual(["state"]);
  });

  it("converts an array of objects", () => {
    const out: any = jsonSchemaToTypebox({
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    });
    expect(out.properties.edits.type).toBe("array");
    expect(out.properties.edits.items.type).toBe("object");
    expect(out.properties.edits.items.properties.path.type).toBe("string");
  });
});

describe("jsonTypeToTypebox", () => {
  it("maps the scalar types", () => {
    expect((jsonTypeToTypebox({ type: "string" }) as any).type).toBe("string");
    expect((jsonTypeToTypebox({ type: "number" }) as any).type).toBe("number");
    expect((jsonTypeToTypebox({ type: "integer" }) as any).type).toBe("integer");
    expect((jsonTypeToTypebox({ type: "boolean" }) as any).type).toBe("boolean");
    expect((jsonTypeToTypebox({ type: "null" }) as any).type).toBe("null");
  });

  it("turns a string enum into a union of literals", () => {
    const out: any = jsonTypeToTypebox({ type: "string", enum: ["open", "closed"] });
    expect(out.anyOf.map((b: any) => b.const)).toEqual(["open", "closed"]);
  });

  it("turns a numeric enum into a union of literals", () => {
    const out: any = jsonTypeToTypebox({ enum: [1, 2, 3] });
    expect(out.anyOf.map((b: any) => b.const)).toEqual([1, 2, 3]);
  });

  it("collapses a single-value enum to that literal", () => {
    expect((jsonTypeToTypebox({ enum: ["only"] }) as any).const).toBe("only");
  });

  it("converts anyOf into a union", () => {
    const out: any = jsonTypeToTypebox({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(out.anyOf.map((b: any) => b.type)).toEqual(["string", "number"]);
  });

  it("treats a type array as a union", () => {
    const out: any = jsonTypeToTypebox({ type: ["string", "null"] });
    expect(out.anyOf.map((b: any) => b.type)).toEqual(["string", "null"]);
  });

  it("treats a property-less object as free-form rather than empty", () => {
    // Type.Object({}) would mean "an object with no fields", which would reject
    // the free-form maps MCP servers routinely declare this way.
    const out: any = jsonTypeToTypebox({ type: "object" });
    expect(out.type).toBeUndefined();
  });

  it("degrades an unknown construct to any instead of throwing", () => {
    expect(() => jsonTypeToTypebox({ $ref: "#/defs/Thing" })).not.toThrow();
    expect(() => jsonTypeToTypebox(null)).not.toThrow();
    expect(() => jsonTypeToTypebox("nonsense")).not.toThrow();
  });
});
