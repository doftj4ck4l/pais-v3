import { eq, lte } from "drizzle-orm";
import { authSessions, db, localAuthAccounts, users } from "../db/client";
import type { AuthSessionRow, LocalAuthAccountRow } from "../models/schema";

export type LocalSessionIdentity = Pick<LocalAuthAccountRow, "userId" | "email">;

export interface LocalAuthStore {
  createAccount(input: LocalAuthAccountRow): Promise<LocalAuthAccountRow | null>;
  findAccountByEmail(email: string): Promise<LocalAuthAccountRow | null>;
  createSession(input: AuthSessionRow): Promise<void>;
  findSession(tokenDigest: string, now: number): Promise<LocalSessionIdentity | null>;
  deleteSession(tokenDigest: string): Promise<void>;
  updatePassword(userId: string, passwordHash: string, updatedAt: number): Promise<void>;
}

export class SqliteLocalAuthStore implements LocalAuthStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async createAccount(input: LocalAuthAccountRow): Promise<LocalAuthAccountRow | null> {
    try {
      return await this.dbImpl.transaction((tx) => {
        tx.insert(users).values({ id: input.userId, createdAt: input.createdAt }).run();
        tx.insert(localAuthAccounts).values(input).run();
        return input;
      });
    } catch (error) {
      if (await this.findAccountByEmail(input.email)) return null;
      throw error;
    }
  }

  async findAccountByEmail(email: string): Promise<LocalAuthAccountRow | null> {
    return (
      this.dbImpl
        .select({
          userId: localAuthAccounts.userId,
          email: localAuthAccounts.email,
          passwordHash: localAuthAccounts.passwordHash,
          createdAt: localAuthAccounts.createdAt,
          updatedAt: localAuthAccounts.updatedAt,
        })
        .from(localAuthAccounts)
        .where(eq(localAuthAccounts.email, email))
        .get() ??
      null
    );
  }

  async createSession(input: AuthSessionRow): Promise<void> {
    this.dbImpl.transaction((tx) => {
      tx.delete(authSessions).where(lte(authSessions.expiresAt, input.createdAt)).run();
      tx.insert(authSessions).values(input).run();
    });
  }

  async findSession(tokenDigest: string, now: number): Promise<LocalSessionIdentity | null> {
    const row = await this.dbImpl
      .select({
        userId: localAuthAccounts.userId,
        email: localAuthAccounts.email,
        expiresAt: authSessions.expiresAt,
      })
      .from(authSessions)
      .innerJoin(localAuthAccounts, eq(localAuthAccounts.userId, authSessions.userId))
      .where(eq(authSessions.tokenDigest, tokenDigest))
      .get();
    if (!row) return null;
    if (row.expiresAt <= now) {
      await this.deleteSession(tokenDigest);
      return null;
    }
    return { userId: row.userId, email: row.email };
  }

  async deleteSession(tokenDigest: string): Promise<void> {
    await this.dbImpl.delete(authSessions).where(eq(authSessions.tokenDigest, tokenDigest));
  }

  async updatePassword(userId: string, passwordHash: string, updatedAt: number): Promise<void> {
    this.dbImpl.transaction((tx) => {
      tx.update(localAuthAccounts)
        .set({ passwordHash, updatedAt })
        .where(eq(localAuthAccounts.userId, userId))
        .run();
      tx.delete(authSessions).where(eq(authSessions.userId, userId)).run();
    });
  }
}

export const localAuthStore: LocalAuthStore = new SqliteLocalAuthStore();
