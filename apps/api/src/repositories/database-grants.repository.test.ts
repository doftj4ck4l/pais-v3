import { beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { sql } from "drizzle-orm";
import { SqliteDatabaseGrantStore } from "./database-grants.repository";

/**
 * The grant store, against a real in-memory schema. `grantedConnectionIdsForWorkspace`
 * is the load-bearing query (it is what the database store unions into every
 * read), so the membership -> workspace join is exercised for real here.
 */

let sqlite: Database;
let store: SqliteDatabaseGrantStore;

beforeAll(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  // Parent rows the grant rows must reference (the junction is FK-bound).
  sqlite.exec(`
    INSERT INTO users (id, created_at) VALUES ('u1', 1);
    INSERT INTO organizations (id, name, created_by_user_id, created_at, updated_at)
    VALUES ('org1', 'One', 'u1', 1, 1), ('org2', 'Two', 'u1', 1, 1);
    INSERT INTO db_connections (id, workspace_id, name, engine, secret, display_host, port, display_database, username, ssl_mode, has_custom_ca, status, error, table_count, last_introspected_at, created_at)
    VALUES ('c1', NULL, 'db', 'postgresql', 's', 'h', 5432, 'db', 'u', 'disable', 0, 'connected', NULL, 0, NULL, 1),
           ('c2', NULL, 'db', 'postgresql', 's', 'h', 5432, 'db', 'u', 'disable', 0, 'connected', NULL, 0, NULL, 1),
           ('c3', NULL, 'db', 'postgresql', 's', 'h', 5432, 'db', 'u', 'disable', 0, 'connected', NULL, 0, NULL, 1),
           ('c9', NULL, 'db', 'postgresql', 's', 'h', 5432, 'db', 'u', 'disable', 0, 'connected', NULL, 0, NULL, 1);
  `);
  store = new SqliteDatabaseGrantStore(drizzle(sqlite) as any);
});

const run = (query: TemplateStringsArray) => sqlite.exec(query.join(""));

describe("SqliteDatabaseGrantStore", () => {
  it("replaces the granted set: adds new ids, keeps existing, removes the rest", async () => {
    await store.setGrants("org1", ["c1", "c2"], "u1", 1000);
    await store.setGrants("org1", ["c2", "c3"], "u1", 2000);

    await expect(store.listGrantedConnectionIds("org1")).resolves.toEqual(["c2", "c3"]);
  });

  it("keeps different organizations' grants independent", async () => {
    await store.setGrants("org2", ["c9"], "u1", 1000);
    await expect(store.listGrantedConnectionIds("org1")).resolves.toEqual(["c2", "c3"]);
    await expect(store.listGrantedConnectionIds("org2")).resolves.toEqual(["c9"]);
  });

  it("unions grants reachable through every membership of the workspace owner", async () => {
    run`INSERT INTO users (id, created_at) VALUES ('alice', 1), ('bob', 1)`;
    run`INSERT INTO organizations (id, name, created_by_user_id, created_at, updated_at)
        VALUES ('acme', 'Acme', 'u1', 1, 1), ('globex', 'Globex', 'u1', 1, 1)`;
    // Two workspaces, one owner (in two departments) and one stranger.
    run`INSERT INTO workspaces (id, user_id, name, created_at) VALUES
        ('ws-a', 'alice', 'A', 1), ('ws-b', 'bob', 'B', 1)`;
    run`INSERT INTO organization_memberships (id, organization_id, user_id, email, role, joined_at)
        VALUES ('m1', 'acme', 'alice', 'alice@x', 'member', 1),
               ('m2', 'globex', 'alice', 'alice@x', 'member', 1)`;
    run`INSERT INTO db_connections (id, workspace_id, name, engine, secret, display_host, port, display_database, username, ssl_mode, has_custom_ca, status, error, table_count, last_introspected_at, created_at)
        VALUES ('db-acme', 'ws-a', 'acme', 'postgresql', 's', 'h', 5432, 'db', 'u', 'disable', 0, 'connected', NULL, 0, NULL, 1),
               ('db-globex', 'ws-a', 'globex', 'postgresql', 's', 'h', 5432, 'db', 'u', 'disable', 0, 'connected', NULL, 0, NULL, 1)`;
    await store.setGrants("acme", ["db-acme"], "u1", 1);
    await store.setGrants("globex", ["db-globex", "db-acme"], "u1", 1);

    await expect(store.grantedConnectionIdsForWorkspace("ws-a")).resolves.toEqual([
      "db-acme",
      "db-globex",
    ]);
    // A stranger's workspace sees none of it.
    await expect(store.grantedConnectionIdsForWorkspace("ws-b")).resolves.toEqual([]);

    // Revoking from one department narrows the union, not the whole set.
    await store.setGrants("globex", [], "u1", 2);
    await expect(store.grantedConnectionIdsForWorkspace("ws-a")).resolves.toEqual(["db-acme"]);
  });

  it("lists only the connections the user owns", async () => {
    run`INSERT INTO users (id, created_at) VALUES ('dee', 1)`;
    run`INSERT INTO workspaces (id, user_id, name, created_at) VALUES ('ws-d', 'dee', 'D', 1)`;
    run`INSERT INTO db_connections (id, workspace_id, name, engine, secret, display_host, port, display_database, username, ssl_mode, has_custom_ca, status, error, table_count, last_introspected_at, created_at)
        VALUES ('conn-dee', 'ws-d', 'db', 'postgresql', 's', 'h', 5432, 'db', 'u', 'disable', 0, 'connected', NULL, 0, NULL, 1)`;
    await expect(store.connectionsOwnedByUser("dee")).resolves.toEqual(["conn-dee"]);
    await expect(store.connectionsOwnedByUser("alice")).resolves.toEqual(["db-acme", "db-globex"]);
  });
});
