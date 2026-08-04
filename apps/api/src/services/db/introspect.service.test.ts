import { describe, expect, it } from "bun:test";
import type { RawCatalog } from "./postgres.driver";
import { buildSnapshot } from "./introspect.service";

/**
 * `buildSnapshot` merges five flat catalog result sets into the nested
 * snapshot the agent reads. That merge is where a wrong join lives (a foreign
 * key attached to the wrong table still looks plausible), so it is exercised
 * here without a database — every case below is pure data in, data out.
 */

const catalog = (over: Partial<RawCatalog> = {}): RawCatalog => ({
  tables: [
    { schemaName: "public", name: "orders", comment: "Customer orders", rowEstimate: 1200 },
    { schemaName: "public", name: "customers", comment: null, rowEstimate: 40 },
  ],
  columns: [
    { schemaName: "public", tableName: "orders", seq: 1, name: "id", dataType: "integer", nullable: false, comment: null },
    { schemaName: "public", tableName: "orders", seq: 2, name: "customer_id", dataType: "integer", nullable: false, comment: null },
    { schemaName: "public", tableName: "orders", seq: 3, name: "status", dataType: "text", nullable: true, comment: "P=pending, X=cancelled" },
    { schemaName: "public", tableName: "customers", seq: 1, name: "id", dataType: "integer", nullable: false, comment: null },
  ],
  primaryKeys: [
    { schemaName: "public", tableName: "orders", columnName: "id" },
    { schemaName: "public", tableName: "customers", columnName: "id" },
  ],
  foreignKeys: [
    { schemaName: "public", tableName: "orders", columnName: "customer_id", refSchema: "public", refTable: "customers", refColumn: "id" },
  ],
  indexes: [
    { schemaName: "public", tableName: "orders", definition: "CREATE INDEX idx_orders_status ON public.orders USING btree (status)" },
  ],
  ...over,
});

describe("buildSnapshot", () => {
  it("groups columns under their table in ordinal order", () => {
    const orders = buildSnapshot(catalog()).find((t) => t.name === "orders")!;
    expect(orders.columns.map((c) => c.name)).toEqual(["id", "customer_id", "status"]);
  });

  it("marks primary keys", () => {
    const orders = buildSnapshot(catalog()).find((t) => t.name === "orders")!;
    expect(orders.columns.find((c) => c.name === "id")!.isPrimaryKey).toBe(true);
    expect(orders.columns.find((c) => c.name === "status")!.isPrimaryKey).toBe(false);
  });

  it("attaches the foreign key that makes a join correct", () => {
    const orders = buildSnapshot(catalog()).find((t) => t.name === "orders")!;
    const fk = orders.columns.find((c) => c.name === "customer_id")!;
    expect(fk.fkTable).toBe("public.customers");
    expect(fk.fkColumn).toBe("id");
  });

  it("carries table and column comments through", () => {
    const orders = buildSnapshot(catalog()).find((t) => t.name === "orders")!;
    expect(orders.comment).toBe("Customer orders");
    expect(orders.columns.find((c) => c.name === "status")!.comment).toBe("P=pending, X=cancelled");
  });

  it("collects index definitions per table", () => {
    const snap = buildSnapshot(catalog());
    expect(snap.find((t) => t.name === "orders")!.indexes).toHaveLength(1);
    expect(snap.find((t) => t.name === "customers")!.indexes).toEqual([]);
  });

  it("keeps a table that has no columns rather than dropping it", () => {
    const snap = buildSnapshot(catalog({ columns: [] }));
    expect(snap).toHaveLength(2);
    expect(snap[0]!.columns).toEqual([]);
  });

  it("ignores catalog rows for a table that is not listed", () => {
    const snap = buildSnapshot(
      catalog({
        columns: [
          { schemaName: "public", tableName: "ghost", seq: 1, name: "x", dataType: "text", nullable: true, comment: null },
        ],
      }),
    );
    expect(snap.every((t) => t.columns.length === 0)).toBe(true);
  });

  it("distinguishes same-named tables in different schemas", () => {
    const snap = buildSnapshot(
      catalog({
        tables: [
          { schemaName: "public", name: "orders", comment: null, rowEstimate: 1 },
          { schemaName: "archive", name: "orders", comment: null, rowEstimate: 2 },
        ],
        columns: [
          { schemaName: "archive", tableName: "orders", seq: 1, name: "archived_at", dataType: "date", nullable: true, comment: null },
        ],
        primaryKeys: [],
        foreignKeys: [],
        indexes: [],
      }),
    );
    expect(snap.find((t) => t.schemaName === "public")!.columns).toEqual([]);
    expect(snap.find((t) => t.schemaName === "archive")!.columns.map((c) => c.name)).toEqual(["archived_at"]);
  });
});
