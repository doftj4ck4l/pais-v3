import { searchDocuments } from "./search.service";
import { documentStore, type DocumentStore } from "../../repositories/document.repository";

/**
 * The `search_docs` tool, bound to one workspace's uploaded documents.
 *
 * Retrieval is a tool rather than a pre-flight injection so the agent can refine:
 * a first search for "refund" that returns nothing can become "cancellation
 * policy" on the next iteration. Every attempt lands on the loop rail, so a bad
 * answer can be traced to the passages that produced it.
 */
export function createDocumentTools(
  workspaceId: string,
  store: DocumentStore = documentStore,
): any[] {
  return [
    {
      name: "search_docs",
      label: "search_docs",
      description:
        "Search the user's uploaded documents (PDFs) for passages relevant to a question. " +
        "Use this whenever the answer might be in their documents, and prefer it over guessing. " +
        "Returns ranked passages, each labelled with its source file and page number. " +
        "Cite those labels in your answer, e.g. [policy.pdf p.4]. " +
        "If the first search returns nothing useful, try again with different wording.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "what to look for, in natural language or keywords" },
          limit: { type: "integer", description: "max passages to return, default 5" },
        },
        required: ["query"],
      },
      async execute(_id: string, params: any) {
        const query = String(params?.query ?? "").trim();
        if (!query) return text("error: query required");

        const limit = Number(params?.limit ?? 5) || 5;
        const result = await searchDocuments(workspaceId, query, limit, store);

        if (!result.ok) {
          return text(`no searchable terms in "${query}" — try different wording`);
        }

        if (!result.hits.length) {
          const docs = await store.list(workspaceId);
          const indexed = docs.filter((d) => d.status === "indexed");
          if (!indexed.length) {
            const pending = docs.length
              ? ` ${docs.length} document(s) were uploaded but none could be indexed ` +
                `(${docs.map((d) => `${d.title}: ${d.status}`).join("; ")}).`
              : " No documents have been uploaded yet.";
            return text(`no passages found.${pending}`);
          }
          return text(
            `no passages matched "${query}" across ${indexed.length} indexed document(s): ` +
              `${indexed.map((d) => d.title).join(", ")}. Try different wording.`,
          );
        }

        // Provenance sits on its own line above each passage so the model has an
        // unambiguous string to copy into its citation.
        const body = result.hits
          .map(
            (h, i) =>
              `[${i + 1}] ${h.docTitle} p.${h.page}  (score ${h.score.toFixed(2)})\n${h.text}`,
          )
          .join("\n\n---\n\n");

        return text(
          `${result.hits.length} passage(s) for "${query}":\n\n${body}\n\n` +
            `Cite sources as [file p.N] using the labels above.`,
        );
      },
    },
  ];
}

function text(out: string) {
  return { content: [{ type: "text" as const, text: out }], details: { output: out } };
}
