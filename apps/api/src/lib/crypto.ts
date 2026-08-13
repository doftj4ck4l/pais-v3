import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "../config/env";

/**
 * Authenticated encryption for stored database credentials.
 *
 * AES-256-GCM rather than a plain cipher because a tampered ciphertext must fail
 * loudly: a connection string that silently decrypts to garbage would be handed
 * to a Postgres driver as a hostname.
 *
 * This protects `app.db` at rest. It does not protect the API — see the Known
 * limitations section of the connector design.
 */

/**
 * Keeps the old product name on purpose. This salt derives the key that every
 * stored secret was encrypted with — MCP headers, database URLs, connector
 * tokens. Renaming it to match the console would not re-encrypt anything; it
 * would derive a different key and make every one of them undecryptable.
 */
const SALT = "salurai.connection.v1";

// scrypt takes ~100ms, and a key is derived on every tool call. Cached by the
// secret itself rather than once, so tests that swap the env var still work.
const derived = new Map<string, Buffer>();

function key(): Buffer {
  const secret = env.connectionSecret;
  if (!secret) {
    throw new Error(
      "CONNECTION_SECRET is not set — refusing to store or read a database credential",
    );
  }
  let k = derived.get(secret);
  if (!k) {
    k = scryptSync(secret, SALT, 32);
    derived.set(secret, k);
  }
  return k;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, bodyB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !bodyB64) {
    throw new Error("malformed encrypted secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
