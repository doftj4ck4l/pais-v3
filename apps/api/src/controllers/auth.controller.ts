import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env } from "../config/env";
import {
  InvalidCredentialsError,
  LOCAL_SESSION_COOKIE,
  localAuthService,
} from "../services/auth/local-auth.service";
import { authenticatedProfileFor } from "../services/auth/profile";

const MAX_FAILURES = 5;
const MAX_CONCURRENT_VERIFICATIONS = 4;
const WINDOW_MS = 15 * 60 * 1000;
type AttemptState = { failures: number; inFlight: number; resetAt: number };
const attempts = new Map<string, AttemptState>();
let concurrentVerifications = 0;

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "Lax" as const,
  secure: env.publicUrl.startsWith("https://"),
  path: "/",
  maxAge: Math.floor(env.localSessionTtlMs / 1000),
};

function attemptKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 320) : "<invalid>";
}

function beginAttempt(key: string, now = Date.now()): "account" | "capacity" | null {
  if (concurrentVerifications >= MAX_CONCURRENT_VERIFICATIONS) return "capacity";
  const current = attempts.get(key);
  const state = current && current.resetAt > now
    ? current
    : { failures: 0, inFlight: 0, resetAt: now + WINDOW_MS };
  if (state.failures + state.inFlight >= MAX_FAILURES) return "account";
  attempts.set(key, { ...state, inFlight: state.inFlight + 1 });
  concurrentVerifications += 1;
  return null;
}

function finishAttempt(key: string, succeeded: boolean, now = Date.now()): void {
  concurrentVerifications = Math.max(0, concurrentVerifications - 1);
  const current = attempts.get(key);
  if (succeeded) {
    attempts.delete(key);
    return;
  }
  const state = current && current.resetAt > now
    ? current
    : { failures: 0, inFlight: 1, resetAt: now + WINDOW_MS };
  attempts.set(key, {
    failures: state.failures + 1,
    inFlight: Math.max(0, state.inFlight - 1),
    resetAt: now + WINDOW_MS,
  });
  if (attempts.size > 2_000) {
    for (const [candidate, state] of attempts) {
      if (state.resetAt <= now || attempts.size > 1_500) attempts.delete(candidate);
    }
  }
}

function cancelAttempt(key: string): void {
  concurrentVerifications = Math.max(0, concurrentVerifications - 1);
  const state = attempts.get(key);
  if (!state) return;
  const inFlight = Math.max(0, state.inFlight - 1);
  if (state.failures === 0 && inFlight === 0) attempts.delete(key);
  else attempts.set(key, { ...state, inFlight });
}

async function readLoginBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function config(c: Context) {
  return c.json({ mode: env.authMode, passwordLogin: env.authMode === "local" });
}

export async function login(c: Context) {
  if (env.authMode !== "local") return c.json({ error: "Password login is not enabled." }, 404);
  const body = await readLoginBody(c);
  if (!body) return c.json({ error: "Enter an email and password." }, 400);
  const email = body.email;
  const password = body.password;
  if (typeof email !== "string" || typeof password !== "string") {
    return c.json({ error: "Enter an email and password." }, 400);
  }

  const key = attemptKey(email);
  const blocked = beginAttempt(key);
  if (blocked) {
    const retryAfter = blocked === "capacity" ? 1 : WINDOW_MS / 1000;
    c.header("Retry-After", String(retryAfter));
    return c.json(
      { error: blocked === "capacity" ? "Sign-in is busy. Try again shortly." : "Too many sign-in attempts. Try again in 15 minutes." },
      429,
    );
  }

  try {
    const session = await localAuthService.login(email, password);
    const user = await authenticatedProfileFor(session.profile);
    finishAttempt(key, true);
    setCookie(c, LOCAL_SESSION_COOKIE, session.token, COOKIE_OPTIONS);
    return c.json({ user });
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      finishAttempt(key, false);
      return c.json({ error: "Email or password is incorrect." }, 401);
    }
    cancelAttempt(key);
    throw error;
  }
}

export async function logout(c: Context) {
  const token = getCookie(c, LOCAL_SESSION_COOKIE);
  if (token) await localAuthService.logout(token);
  deleteCookie(c, LOCAL_SESSION_COOKIE, COOKIE_OPTIONS);
  return c.json({ ok: true });
}
