import { memoryStore, type MemoryEntry, type MemoryStore } from "../repositories/memory.repository";

const genId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The `remember` / `recall` tools, bound to one user's memory. Handed to the pi
 * runtime alongside the built-in tools.
 */
export function createMemoryTools(userId: string, store: MemoryStore = memoryStore): any[] {
  return [
    {
      name: "remember",
      label: "remember",
      description:
        "Persist a fact/note about the user or the conversation to long-term memory so it can be recalled in future sessions. Use for durable facts (names, preferences, decisions). Supply short 'tags' to make recall easier.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["content"],
      },
      async execute(_id: string, params: any) {
        const content = String(params?.content ?? "").trim();
        if (!content) {
          return { content: [{ type: "text" as const, text: "error: content required" }] };
        }
        const entry: MemoryEntry = {
          id: genId(),
          ts: Date.now(),
          content,
          tags: Array.isArray(params?.tags) ? params.tags.map(String) : undefined,
        };
        await store.append(userId, entry);
        return { content: [{ type: "text" as const, text: `remembered: ${content}` }] };
      },
    },
    {
      name: "recall",
      label: "recall",
      description:
        "Search long-term memory (notes saved across sessions) for facts about the user or past conversations. Use before answering when you need remembered context. Empty query returns the most recent notes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "search term or empty for recent" },
          limit: { type: "integer", description: "max results, default 5" },
        },
      },
      async execute(_id: string, params: any) {
        const query = String(params?.query ?? "");
        const limit = Math.max(1, Math.min(20, Number(params?.limit ?? 5) || 5));
        const matches = await store.search(userId, query);
        const recent = matches.slice(0, limit); // already newest-first
        if (!recent.length) {
          return {
            content: [{ type: "text" as const, text: `no memory notes matching "${query}"` }],
          };
        }
        const text = recent
          .map(
            (e, i) =>
              `[${i + 1}] ${e.content}${e.tags?.length ? ` (tags: ${e.tags.join(", ")})` : ""} @ ${new Date(e.ts).toISOString()}`,
          )
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `memory (${recent.length}):\n${text}` }],
        };
      },
    },
  ];
}
