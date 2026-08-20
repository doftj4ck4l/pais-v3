import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pixelspace-local-admin-"));
  temporary.push(directory);
  return {
    dbPath: path.join(directory, "app.db"),
    env: {
      ...process.env,
      AUTH_MODE: "local",
      DB_PATH: path.join(directory, "app.db"),
      SUPER_ADMIN_EMAILS: "admin@example.com",
    },
  };
}

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  password?: string,
) {
  return Bun.spawnSync([process.execPath, "src/cli/local-admin.ts", ...args], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    env,
    stdin: password === undefined ? undefined : Buffer.from(`${password}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("local administrator CLI", () => {
  it("creates one account idempotently and reports status", () => {
    const fx = fixture();
    expect(runCli(["status", "--email", "admin@example.com"], fx.env).exitCode).toBe(3);

    const created = runCli(
      ["create", "--email", "Admin@Example.COM"],
      fx.env,
      "correct horse battery staple",
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout.toString()).toContain("Created local administrator admin@example.com");
    expect(runCli(["status", "--email", "admin@example.com"], fx.env).exitCode).toBe(0);

    const sqlite = new Database(fx.dbPath);
    const before = sqlite.query("SELECT password_hash FROM local_auth_accounts").get();
    expect(
      runCli(["create", "--email", "admin@example.com"], fx.env, "a different valid password")
        .exitCode,
    ).toBe(0);
    const after = sqlite.query("SELECT password_hash FROM local_auth_accounts").get();
    expect(after).toEqual(before);
    sqlite.close();
  });

  it("resets the password and revokes active sessions", () => {
    const fx = fixture();
    expect(
      runCli(
        ["create", "--email", "admin@example.com"],
        fx.env,
        "correct horse battery staple",
      ).exitCode,
    ).toBe(0);
    const sqlite = new Database(fx.dbPath);
    const account = sqlite.query("SELECT user_id FROM local_auth_accounts").get() as { user_id: string };
    sqlite
      .query(
        "INSERT INTO auth_sessions (token_digest, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run("digest", account.user_id, Date.now(), Date.now() + 60_000);
    sqlite.close();

    const reset = runCli(
      ["reset", "--email", "admin@example.com"],
      fx.env,
      "a completely new password",
    );
    expect(reset.exitCode).toBe(0);

    const verified = new Database(fx.dbPath, { readonly: true });
    expect(verified.query("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 0 });
    verified.close();
  });

  it("rejects invalid and oversized password input with documented exit codes", () => {
    const fx = fixture();
    expect(runCli(["create", "--email", "admin@example.com"], fx.env, "too-short").exitCode).toBe(2);
    expect(runCli(["reset", "--email", "missing@example.com"], fx.env, "a valid missing password").exitCode).toBe(4);
    expect(runCli(["create", "--email", "admin@example.com"], fx.env, "x".repeat(1_025)).exitCode).toBe(1);
  });
});
