/**
 * Prove the read-only guarantee against a real PostgreSQL server.
 *
 * The unit tests cover the statement guard exhaustively, but a passing guard
 * test says nothing about whether the transaction layer works — and the
 * transaction is the layer that actually protects the database. This script
 * bypasses the guard and sends a write directly, so a failure there means the
 * real defence is broken, not just the string check in front of it.
 *
 * It also proves two things no unit test can, because both depend on how a
 * real server schedules connections rather than on anything the code
 * controls: that `max: 1` genuinely pins BEGIN / query / ROLLBACK to a single
 * backend (the whole guarantee rests on that holding), and that a `WITH`
 * CTE and a trailing `--` comment both survive being wrapped in the row-cap
 * subquery.
 *
 *   DB_CHECK_URL=postgres://user:pass@host:5432/db bun scripts/db-connector-check.ts
 */
import { fetchCatalog, probe, runReadOnly } from "../src/services/db/postgres.driver";
import { buildSnapshot } from "../src/services/db/introspect.service";

const url = process.env.DB_CHECK_URL;
if (!url) {
  console.error("Set DB_CHECK_URL to a PostgreSQL connection string.");
  process.exit(1);
}

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const reached = await probe(url);
check("connects", reached.ok, reached.ok ? `${reached.database} @ ${reached.host}` : reached.error);
if (!reached.ok) process.exit(1);

const catalog = await fetchCatalog(url);
const snapshot = buildSnapshot(catalog);
check("introspects", snapshot.length > 0, `${snapshot.length} tables`);
check(
  "captures foreign keys",
  catalog.foreignKeys.length === 0 ||
    snapshot.some((t) => t.columns.some((c) => c.fkTable !== null)),
  `${catalog.foreignKeys.length} in catalog`,
);
check(
  "captures table and column comments",
  snapshot.some((t) => t.comment !== null) && snapshot.some((t) => t.columns.some((c) => c.comment !== null)),
);
check(
  "captures indexes",
  snapshot.some((t) => t.indexes.length > 0),
);

const select = await runReadOnly(url, "SELECT 1 AS one");
check("runs a select", select.ok && select.rows.length === 1);

const capped = await runReadOnly(url, "SELECT generate_series(1, 500) AS n", 10);
check("caps rows", capped.ok && capped.rows.length === 10 && capped.truncated);

const cte = await runReadOnly(url, "WITH ranked AS (SELECT n FROM generate_series(1, 5) AS n) SELECT * FROM ranked");
check(
  "a WITH CTE survives the row-cap subquery wrap",
  cte.ok && cte.rows.length === 5,
  cte.ok ? "" : cte.error,
);

const trailingComment = await runReadOnly(url, "SELECT 1 AS one -- note");
check(
  "a trailing line comment survives the row-cap subquery wrap",
  trailingComment.ok && trailingComment.rows.length === 1,
  trailingComment.ok ? "" : trailingComment.error,
);

const blocked = await runReadOnly(url, "CREATE TABLE salurai_should_not_exist (id int)");
check("guard rejects a write", !blocked.ok, blocked.ok ? "" : blocked.error);

// The guard is bypassed here on purpose: this is the only assertion that tests
// the transaction layer rather than the string check in front of it.
const sql = new Bun.SQL({ url, max: 1 });
let engineBlocked = false;
let engineDetail = "";
try {
  await sql.unsafe("BEGIN TRANSACTION READ ONLY");
  await sql.unsafe("CREATE TABLE salurai_should_not_exist (id int)");
} catch (e: any) {
  engineBlocked = true;
  engineDetail = e?.message ?? String(e);
} finally {
  await sql.unsafe("ROLLBACK").catch(() => {});
  await sql.close().catch(() => {});
}
check("READ ONLY transaction rejects a write with the guard bypassed", engineBlocked, engineDetail);
if (!engineBlocked) {
  console.error(
    "\nBLOCKED: the READ ONLY transaction did not reject a write. This is the " +
      "primary defence — no amount of guard testing compensates for it being " +
      "broken. Stopping here.",
  );
  process.exit(1);
}

// `runReadOnly` issues BEGIN, the query, and ROLLBACK as three separate
// statements. That is only safe because the pool holds exactly one
// connection (`max: 1`) — if those statements could land on different
// backends, the transaction would not actually wrap the query, while every
// other check above would still appear to pass. Proved directly by reading
// the backend pid at both ends of the same shape of sequence.
const pidClient = new Bun.SQL({ url, max: 1 });
let pidAtStart: number | null = null;
let pidAtEnd: number | null = null;
try {
  await pidClient.unsafe("BEGIN TRANSACTION READ ONLY");
  const first = await pidClient.unsafe("SELECT pg_backend_pid() AS pid");
  pidAtStart = Number(first[0].pid);
  await pidClient.unsafe("SELECT 1");
  const second = await pidClient.unsafe("SELECT pg_backend_pid() AS pid");
  pidAtEnd = Number(second[0].pid);
} finally {
  await pidClient.unsafe("ROLLBACK").catch(() => {});
  await pidClient.close().catch(() => {});
}
check(
  "max: 1 pins BEGIN / query / ROLLBACK to one backend connection",
  pidAtStart !== null && pidAtStart === pidAtEnd,
  `pid ${pidAtStart} -> ${pidAtEnd}`,
);

const timeout = await runReadOnly(url, "SELECT pg_sleep(30)");
check("cancels a slow statement", !timeout.ok, timeout.ok ? "" : timeout.error);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
