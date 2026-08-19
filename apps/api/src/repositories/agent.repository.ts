import { and, desc, eq } from "drizzle-orm";
import { agentDefinitions, db } from "../db/client";
import type { AgentDefinitionRow } from "../models/schema";

export type { AgentDefinitionRow } from "../models/schema";

export type NewAgentDefinition = Pick<
  AgentDefinitionRow,
  "id" | "workspaceId" | "name" | "systemPrompt" | "modelId" | "tokenDigest" | "tokenHint"
>;

export type UpdateAgentDefinition = Partial<
  Pick<AgentDefinitionRow, "name" | "systemPrompt" | "modelId" | "tokenDigest" | "tokenHint">
>;

export interface AgentStore {
  create(input: NewAgentDefinition): Promise<AgentDefinitionRow>;
  list(workspaceId: string): Promise<AgentDefinitionRow[]>;
  getOwned(workspaceId: string, id: string): Promise<AgentDefinitionRow | null>;
  findByTokenDigest(tokenDigest: string): Promise<AgentDefinitionRow | null>;
  update(
    workspaceId: string,
    id: string,
    patch: UpdateAgentDefinition,
  ): Promise<AgentDefinitionRow | null>;
  markUsed(id: string): Promise<void>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

export class SqliteAgentStore implements AgentStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(input: NewAgentDefinition): Promise<AgentDefinitionRow> {
    const now = Date.now();
    const row: AgentDefinitionRow = {
      ...input,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.dbImpl.insert(agentDefinitions).values(row);
    return row;
  }

  async list(workspaceId: string): Promise<AgentDefinitionRow[]> {
    return (await this.dbImpl
      .select()
      .from(agentDefinitions)
      .where(eq(agentDefinitions.workspaceId, workspaceId))
      .orderBy(desc(agentDefinitions.updatedAt), desc(agentDefinitions.id))) as AgentDefinitionRow[];
  }

  async getOwned(workspaceId: string, id: string): Promise<AgentDefinitionRow | null> {
    const rows = await this.dbImpl
      .select()
      .from(agentDefinitions)
      .where(and(eq(agentDefinitions.workspaceId, workspaceId), eq(agentDefinitions.id, id)))
      .limit(1);
    return (rows[0] as AgentDefinitionRow | undefined) ?? null;
  }

  async findByTokenDigest(tokenDigest: string): Promise<AgentDefinitionRow | null> {
    const rows = await this.dbImpl
      .select()
      .from(agentDefinitions)
      .where(eq(agentDefinitions.tokenDigest, tokenDigest))
      .limit(1);
    return (rows[0] as AgentDefinitionRow | undefined) ?? null;
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAgentDefinition,
  ): Promise<AgentDefinitionRow | null> {
    const changed = this.dbImpl
      .update(agentDefinitions)
      .set({ ...patch, updatedAt: Date.now() })
      .where(and(eq(agentDefinitions.workspaceId, workspaceId), eq(agentDefinitions.id, id)))
      .returning()
      .get();
    return (changed as AgentDefinitionRow | undefined) ?? null;
  }

  async markUsed(id: string): Promise<void> {
    await this.dbImpl
      .update(agentDefinitions)
      .set({ lastUsedAt: Date.now() })
      .where(eq(agentDefinitions.id, id));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const changed = this.dbImpl
      .delete(agentDefinitions)
      .where(and(eq(agentDefinitions.workspaceId, workspaceId), eq(agentDefinitions.id, id)))
      .returning({ id: agentDefinitions.id })
      .get();
    return Boolean(changed);
  }
}

export const agentStore: AgentStore = new SqliteAgentStore();
