import { fetchCatalog, type CatalogStep, type RawCatalog } from "./postgres.driver";
import {
  databaseConnectionStore,
  type DatabaseConnectionStore,
} from "../../repositories/database-connection.repository";
import { logger } from "../../lib/logger";

/**
 * Turn a database's catalog into the snapshot the agent reads.
 *
 * `buildSnapshot` is pure and holds all the merge logic — five flat result sets
 * folded into one structure. That is where the bugs live (a foreign key attached
 * to the wrong table produces a plausible, wrong join), so it is separated from
 * the I/O and tested exhaustively without a database.
 */

export type SnapshotColumn = {
  seq: number;
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  fkTable: string | null;
  fkColumn: string | null;
  comment: string | null;
};

export type SnapshotTable = {
  schemaName: string;
  name: string;
  comment: string | null;
  rowEstimate: number;
  indexes: string[];
  columns: SnapshotColumn[];
};

const qualify = (schemaName: string, name: string) => `${schemaName}.${name}`;

export function buildSnapshot(raw: RawCatalog): SnapshotTable[] {
  const pkSet = new Set(
    raw.primaryKeys.map((p) => `${qualify(p.schemaName, p.tableName)}.${p.columnName}`),
  );

  const fkMap = new Map<string, { fkTable: string; fkColumn: string }>();
  for (const f of raw.foreignKeys) {
    fkMap.set(`${qualify(f.schemaName, f.tableName)}.${f.columnName}`, {
      fkTable: qualify(f.refSchema, f.refTable),
      fkColumn: f.refColumn,
    });
  }

  const indexMap = new Map<string, string[]>();
  for (const idx of raw.indexes) {
    const key = qualify(idx.schemaName, idx.tableName);
    const list = indexMap.get(key) ?? [];
    list.push(idx.definition);
    indexMap.set(key, list);
  }

  const columnMap = new Map<string, SnapshotColumn[]>();
  for (const c of raw.columns) {
    const key = qualify(c.schemaName, c.tableName);
    const fk = fkMap.get(`${key}.${c.name}`);
    const list = columnMap.get(key) ?? [];
    list.push({
      seq: c.seq,
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      isPrimaryKey: pkSet.has(`${key}.${c.name}`),
      fkTable: fk?.fkTable ?? null,
      fkColumn: fk?.fkColumn ?? null,
      comment: c.comment,
    });
    columnMap.set(key, list);
  }

  // Driven by `raw.tables`, so a column belonging to a table the catalog query
  // excluded (a system table, a dropped relation) cannot conjure one into being.
  return raw.tables.map((t) => {
    const key = qualify(t.schemaName, t.name);
    return {
      schemaName: t.schemaName,
      name: t.name,
      comment: t.comment,
      rowEstimate: t.rowEstimate,
      indexes: indexMap.get(key) ?? [],
      columns: (columnMap.get(key) ?? []).sort((a, b) => a.seq - b.seq),
    };
  });
}

/**
 * What introspection is doing, reported as it happens.
 *
 * Attaching a database is the one place this feature does real work before the
 * user sees anything, and against a remote server with a wide schema it is five
 * sequential round trips plus a write. A spinner makes that indistinguishable
 * from a hang; these phases make it legible, and a failure names the step it
 * died on instead of surfacing as one opaque error string.
 */
export type IntrospectPhase =
  | { phase: "catalog"; step: CatalogStep["step"]; count: number }
  | { phase: "building"; tables: number; columns: number }
  | { phase: "indexing"; entries: number }
  | { phase: "done"; tables: number; columns: number; entries: number; ms: number }
  | { phase: "failed"; step: string; error: string };

/** Human-readable name for the step a failure happened on. */
const STEP_LABEL: Record<string, string> = {
  tables: "reading tables",
  columns: "reading columns",
  primaryKeys: "reading primary keys",
  foreignKeys: "reading foreign keys",
  indexes: "reading indexes",
  building: "building the snapshot",
  indexing: "indexing for search",
};

/**
 * Introspect a connection and replace its snapshot.
 *
 * A failure is recorded on the connection rather than thrown: the user added it
 * and needs to see what happened, the same way a PDF that cannot be parsed still
 * gets a row.
 *
 * `onPhase` is optional and purely observational — nothing about the outcome
 * depends on whether anyone is listening, so the non-streaming callers are
 * unaffected.
 */
export async function introspectConnection(
  connectionId: string,
  userId: string,
  url: string,
  store: DatabaseConnectionStore = databaseConnectionStore,
  onPhase?: (event: IntrospectPhase) => void,
): Promise<{ ok: true; tableCount: number } | { ok: false; error: string }> {
  const startedAt = Date.now();
  // Tracks how far we got, so a failure can name the step rather than leaving
  // the user to guess which of five round trips died.
  let reached = "tables";

  try {
    const raw = await fetchCatalog(url, (s) => {
      reached = s.step;
      onPhase?.({ phase: "catalog", step: s.step, count: s.count });
    });

    reached = "building";
    const tables = buildSnapshot(raw);
    const columnCount = tables.reduce((n, t) => n + t.columns.length, 0);
    onPhase?.({ phase: "building", tables: tables.length, columns: columnCount });

    // One FTS row per table plus one per column — the index `search_schema`
    // ranks against, and the largest write of the whole pipeline.
    reached = "indexing";
    const entries = tables.length + columnCount;
    onPhase?.({ phase: "indexing", entries });

    await store.saveSnapshot(connectionId, userId, tables);

    const ms = Date.now() - startedAt;
    logger.info("db.introspected", { connectionId, tables: tables.length, ms });
    onPhase?.({ phase: "done", tables: tables.length, columns: columnCount, entries, ms });
    return { ok: true, tableCount: tables.length };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    await store.markStatus(userId, connectionId, "error", error);
    logger.warn("db.introspect_failed", { connectionId, step: reached, error });
    onPhase?.({ phase: "failed", step: STEP_LABEL[reached] ?? reached, error });
    return { ok: false, error };
  }
}
