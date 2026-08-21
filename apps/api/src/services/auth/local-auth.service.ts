import { createHash, randomBytes, randomUUID } from "node:crypto";
import { env } from "../../config/env";
import {
  localAuthStore,
  type LocalAuthStore,
  type LocalSessionIdentity,
} from "../../repositories/local-auth.repository";
import { normalizeEmail } from "./identity";
import type { UserProfile } from "./types";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$8WZ/cKqzLeMY1ssiIIyUQyJlE96a/O7QqyFEF+p2SJg$z2UjF1Yx0xJG/bLKddzV9v1rQOHN541zkYWhQP4HJO0";

type LocalIdentity = UserProfile & Required<Pick<UserProfile, "username" | "email">>;

export const LOCAL_SESSION_COOKIE = "pixelspace_session";

export class PasswordPolicyError extends Error {}
export class LocalAccountExistsError extends Error {}
export class LocalAccountNotFoundError extends Error {}
export class InvalidCredentialsError extends Error {}

type LocalAuthOptions = {
  hashPassword?: (password: string) => Promise<string>;
  verifyPassword?: (password: string, hash: string) => Promise<boolean>;
  now?: () => number;
  sessionTtlMs?: number;
  mintSessionToken?: () => string;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
}

function profile(identity: LocalSessionIdentity): LocalIdentity {
  return {
    id: identity.userId,
    username: identity.email.split("@", 1)[0]!,
    email: identity.email,
    groups: [],
  };
}

export class LocalAuthService {
  private readonly hashPassword: (password: string) => Promise<string>;
  private readonly verifyPassword: (password: string, hash: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly mintSessionToken: () => string;

  constructor(
    private readonly store: LocalAuthStore = localAuthStore,
    options: LocalAuthOptions = {},
  ) {
    this.hashPassword =
      options.hashPassword ??
      ((password) =>
        Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65_536, timeCost: 2 }));
    this.verifyPassword = options.verifyPassword ?? Bun.password.verify;
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? env.localSessionTtlMs;
    this.mintSessionToken =
      options.mintSessionToken ?? (() => `pss_${randomBytes(32).toString("base64url")}`);
  }

  async bootstrap(emailInput: string, password: string) {
    const email = normalizeEmail(emailInput);
    validatePassword(password);
    const now = this.now();
    const account = await this.store.createAccount({
      userId: `usr_${randomUUID()}`,
      email,
      passwordHash: await this.hashPassword(password),
      createdAt: now,
      updatedAt: now,
    });
    if (!account) throw new LocalAccountExistsError("A local account already uses this email.");
    return { userId: account.userId, email: account.email };
  }

  async hasAccount(emailInput: string): Promise<boolean> {
    return Boolean(await this.store.findAccountByEmail(normalizeEmail(emailInput)));
  }

  async login(emailInput: string, password: string) {
    let email: string | null = null;
    try {
      email = normalizeEmail(emailInput);
    } catch {
      // Keep malformed and unknown identities on the same verification path.
    }
    const account = email ? await this.store.findAccountByEmail(email) : null;
    const valid = await this.verifyPassword(password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!account || !valid) throw new InvalidCredentialsError("Email or password is incorrect.");

    const token = this.mintSessionToken();
    const now = this.now();
    await this.store.createSession({
      tokenDigest: digest(token),
      userId: account.userId,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    });
    return { token, profile: profile(account), expiresAt: now + this.sessionTtlMs };
  }

  async authenticate(token: string): Promise<LocalIdentity | null> {
    const identity = await this.store.findSession(digest(token), this.now());
    return identity ? profile(identity) : null;
  }

  async logout(token: string): Promise<void> {
    await this.store.deleteSession(digest(token));
  }

  async resetPassword(emailInput: string, password: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    validatePassword(password);
    const account = await this.store.findAccountByEmail(email);
    if (!account) throw new LocalAccountNotFoundError("No local account uses this email.");
    await this.store.updatePassword(account.userId, await this.hashPassword(password), this.now());
  }
}

export const localAuthService = new LocalAuthService();
