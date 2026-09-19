const NEXTPLUS_DOMAIN = "nextplus.com.my";

/**
 * Source-routing rules that depend on tools actually active for this turn.
 * Keeping them conditional prevents a chat-only or unconfigured run from being
 * ordered to call a tool it cannot see.
 */
export function sourceRoutingPrompt(activeToolNames: Iterable<string>): string {
  const active = new Set(activeToolNames);
  if (!active.has("web_search") || !active.has("fetch_url")) return "";

  return (
    `\n\nWhen the user asks what the NextPlus system is, or uses equivalent wording ` +
    `about NextPlus / Next Plus, you MUST first call "web_search" with a query ` +
    `restricted to the official domain, such as "site:${NEXTPLUS_DOMAIN} NextPlus system". ` +
    `Then call "fetch_url" on the most relevant ${NEXTPLUS_DOMAIN} result before answering. ` +
    `Treat the official site as the primary context, cite the official URL in the answer, and ` +
    `do not answer this question from memory or unrelated search results.`
  );
}
