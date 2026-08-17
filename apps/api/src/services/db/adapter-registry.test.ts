import { describe, expect, it } from "bun:test";
import { DatabaseAdapterRegistry } from "./adapter-registry";
import type { DatabaseAdapter } from "./database-adapter";

const fakeAdapter = (engine: string): DatabaseAdapter => ({
  engine,
  defaultPort: 1234,
  capabilities: {
    schemas: true,
    explain: true,
    sslModes: ["disable"],
    readOnlyTransactions: true,
    statementTimeout: true,
  },
  validate: () => null,
  quoteIdentifier: (identifier) => `\"${identifier}\"`,
  testConnection: async () => ({ ok: true, value: {} }),
  fetchCatalog: async () => ({
    ok: true,
    value: { tables: [], columns: [], primaryKeys: [], foreignKeys: [], indexes: [] },
  }),
  executeReadOnly: async () => ({ ok: true, columns: [], rows: [], truncated: false }),
});

describe("DatabaseAdapterRegistry", () => {
  it("registers a future driver without changing the adapter contract", () => {
    const registry = new DatabaseAdapterRegistry().register(fakeAdapter("postgresql"));
    const agentToolNames = ["search_schema", "describe_table", "run_query"];

    registry.register(fakeAdapter("mysql"));

    expect(registry.engines()).toEqual(["postgresql", "mysql"]);
    expect(registry.get("mysql")?.defaultPort).toBe(1234);
    expect(agentToolNames).toEqual(["search_schema", "describe_table", "run_query"]);
  });

  it("rejects duplicate engine registrations", () => {
    const registry = new DatabaseAdapterRegistry().register(fakeAdapter("postgresql"));
    expect(() => registry.register(fakeAdapter("postgresql"))).toThrow(/already registered/);
  });
});
