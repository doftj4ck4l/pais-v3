import { describe, expect, it } from "bun:test";
import { DatabaseAdapterRegistry } from "./adapter-registry";
import type { ApprovedDatabaseTarget, DatabaseAdapter, DatabaseConnectionConfig } from "./database-adapter";
import { DatabaseConnectorService } from "./database-connector.service";
import { DatabaseNetworkPolicy } from "./network-policy";

const config: DatabaseConnectionConfig = {
  engine: "future-db",
  host: "warehouse.internal",
  port: 4444,
  database: "sales",
  username: "reader",
  password: "super-secret",
  ssl: { mode: "disable" },
};

function setup(adapterOverrides: Partial<DatabaseAdapter> = {}) {
  let target: ApprovedDatabaseTarget | null = null;
  const adapter: DatabaseAdapter = {
    engine: "future-db",
    defaultPort: 4444,
    capabilities: {
      schemas: true,
      explain: true,
      sslModes: ["disable"],
      readOnlyTransactions: true,
      statementTimeout: true,
    },
    validate: () => null,
    quoteIdentifier: (value) => value,
    testConnection: async (_config, approved) => {
      target = approved;
      return { ok: true, value: { serverVersion: "1.0" } };
    },
    fetchCatalog: async () => ({
      ok: true,
      value: { tables: [], columns: [], primaryKeys: [], foreignKeys: [], indexes: [] },
    }),
    executeReadOnly: async () => ({ ok: true, columns: [], rows: [], truncated: false }),
    ...adapterOverrides,
  };
  const registry = new DatabaseAdapterRegistry().register(adapter);
  const policy = new DatabaseNetworkPolicy({
    lookup: (async () => [{ address: "10.35.180.238", family: 4 }]) as any,
  });
  return { connector: new DatabaseConnectorService(registry, policy), getTarget: () => target };
}

describe("DatabaseConnectorService", () => {
  it("pins the approved address before calling a future adapter", async () => {
    const { connector, getTarget } = setup();
    const result = await connector.testConnection(config);
    expect(result.ok).toBe(true);
    expect(getTarget()).toEqual({
      originalHost: "warehouse.internal",
      address: "10.35.180.238",
      family: 4,
    });
  });

  it("redacts passwords and complete URLs from future-adapter errors", async () => {
    const { connector } = setup({
      executeReadOnly: async () => ({
        ok: false,
        error: {
          code: "query_failed",
          message: "failed at postgresql://reader:super-secret@warehouse.internal:5432/sales",
        },
      }),
    });
    const result = await connector.executeReadOnly(config, "SELECT 1");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("warehouse.internal:5432/sales");
  });

  it("rejects unsupported engines before network access", async () => {
    const registry = new DatabaseAdapterRegistry();
    let lookedUp = false;
    const policy = new DatabaseNetworkPolicy({
      lookup: (async () => { lookedUp = true; return []; }) as any,
    });
    const result = await new DatabaseConnectorService(registry, policy).testConnection(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_engine");
    expect(lookedUp).toBe(false);
  });
});
