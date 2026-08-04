import { afterEach, describe, expect, it } from "bun:test";
import { env } from "../config/env";
import { decryptSecret, encryptSecret } from "./crypto";

const original = env.connectionSecret;
const setSecret = (v: string) => {
  (env as { connectionSecret: string }).connectionSecret = v;
};

afterEach(() => setSecret(original));

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a connection string", () => {
    setSecret("test-secret-one");
    const url = "postgres://reader:hunter2@db.example.com:5432/sales";
    expect(decryptSecret(encryptSecret(url))).toBe(url);
  });

  it("produces different ciphertext for the same plaintext", () => {
    setSecret("test-secret-one");
    expect(encryptSecret("postgres://a@b/c")).not.toBe(encryptSecret("postgres://a@b/c"));
  });

  it("fails to decrypt under a different key", () => {
    setSecret("test-secret-one");
    const payload = encryptSecret("postgres://a@b/c");
    setSecret("test-secret-two");
    expect(() => decryptSecret(payload)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    setSecret("test-secret-one");
    const parts = encryptSecret("postgres://a@b/c").split(".");
    const body = Buffer.from(parts[3]!, "base64");
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("refuses to encrypt with no secret configured", () => {
    setSecret("");
    expect(() => encryptSecret("postgres://a@b/c")).toThrow(/CONNECTION_SECRET/);
  });

  it("rejects a malformed payload", () => {
    setSecret("test-secret-one");
    expect(() => decryptSecret("not-a-payload")).toThrow(/malformed/);
  });
});
