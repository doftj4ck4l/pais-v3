import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { SqliteLocalAuthStore } from "../../repositories/local-auth.repository";
import {
  InvalidCredentialsError,
  LocalAccountExistsError,
  LocalAuthService,
  PasswordPolicyError,
} from "./local-auth.service";

describe("LocalAuthService", () => {
  let sqlite: Database;
  let service: LocalAuthService;
  let now: number;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applySchema(sqlite);
    now = 1_800_000_000_000;
    service = new LocalAuthService(new SqliteLocalAuthStore(drizzle(sqlite)), {
      hashPassword: async (password) => `hashed:${password}`,
      verifyPassword: async (password, hash) => hash === `hashed:${password}`,
      now: () => now,
      sessionTtlMs: 60_000,
      mintSessionToken: () => "pss_test-session-token",
    });
  });

  it("bootstraps one normalized local account without storing plaintext", async () => {
    const account = await service.bootstrap(" Admin@Example.COM ", "correct horse battery staple");

    expect(account.email).toBe("admin@example.com");
    expect(account.userId).toStartWith("usr_");
    const stored = sqlite.query(
      "SELECT email, password_hash FROM local_auth_accounts",
    ).get() as { email: string; password_hash: string };
    expect(stored).toEqual({
      email: "admin@example.com",
      password_hash: "hashed:correct horse battery staple",
    });
    expect(JSON.stringify(stored)).not.toContain('"correct horse battery staple"');
  });

  it("refuses a second account with the same email", async () => {
    await service.bootstrap("admin@example.com", "correct horse battery staple");

    expect(service.bootstrap("ADMIN@example.com", "another secure password")).rejects.toBeInstanceOf(
      LocalAccountExistsError,
    );
  });

  it("enforces the password policy before hashing", async () => {
    expect(service.bootstrap("admin@example.com", "too-short")).rejects.toBeInstanceOf(
      PasswordPolicyError,
    );
  });

  it("creates a digest-only session for valid credentials", async () => {
    const account = await service.bootstrap("admin@example.com", "correct horse battery staple");

    const session = await service.login("ADMIN@example.com", "correct horse battery staple");

    expect(session.token).toBe("pss_test-session-token");
    expect(session.profile).toMatchObject({ id: account.userId, email: "admin@example.com" });
    const stored = sqlite.query("SELECT token_digest, user_id, expires_at FROM auth_sessions").get() as {
      token_digest: string;
      user_id: string;
      expires_at: number;
    };
    expect(stored.token_digest).not.toContain(session.token);
    expect(stored.user_id).toBe(account.userId);
    expect(stored.expires_at).toBe(1_800_000_060_000);
  });

  it("sweeps abandoned expired sessions when creating a new session", async () => {
    const account = await service.bootstrap("admin@example.com", "correct horse battery staple");
    sqlite
      .query(
        "INSERT INTO auth_sessions (token_digest, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run("expired-digest", account.userId, 1_799_999_000_000, 1_799_999_999_999);

    await service.login("admin@example.com", "correct horse battery staple");

    expect(sqlite.query("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
    expect(
      sqlite.query("SELECT 1 FROM auth_sessions WHERE token_digest = 'expired-digest'").get(),
    ).toBeNull();
  });

  it("returns one generic error for unknown accounts and wrong passwords", async () => {
    await service.bootstrap("admin@example.com", "correct horse battery staple");

    expect(service.login("missing@example.com", "wrong password here")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(service.login("admin@example.com", "wrong password here")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("resolves active sessions and revokes on logout", async () => {
    await service.bootstrap("admin@example.com", "correct horse battery staple");
    const session = await service.login("admin@example.com", "correct horse battery staple");

    expect(await service.authenticate(session.token)).toMatchObject({ email: "admin@example.com" });
    await service.logout(session.token);
    expect(await service.authenticate(session.token)).toBeNull();
  });

  it("rejects and deletes an expired session", async () => {
    await service.bootstrap("admin@example.com", "correct horse battery staple");
    const session = await service.login("admin@example.com", "correct horse battery staple");

    now += 60_001;

    expect(await service.authenticate(session.token)).toBeNull();
    expect(sqlite.query("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 0 });
  });

  it("resets the password and revokes every existing session", async () => {
    await service.bootstrap("admin@example.com", "correct horse battery staple");
    const session = await service.login("admin@example.com", "correct horse battery staple");

    await service.resetPassword("admin@example.com", "a completely new password");

    expect(await service.authenticate(session.token)).toBeNull();
    await expect(
      service.login("admin@example.com", "correct horse battery staple"),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect((await service.login("admin@example.com", "a completely new password")).profile.email).toBe(
      "admin@example.com",
    );
  });
});
