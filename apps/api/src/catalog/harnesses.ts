export type Harness = {
  id: string;
  label: string;
  description: string;
  /** Style hints — differs per harness so you can see the difference. */
  tagline: string;
  systemPrompt: string;
  /**
   * Which real runtime backs this harness. Currently only the real pi runtime
   * is wired ("pi"); the opencode harness was removed.
   */
  driver: "prompt" | "pi";
  /** Max tool-calling loop iterations before forcing a final answer. */
  maxIterations: number;
  /**
   * Optional capability gates. A harness only receives the tool groups it names,
   * so the general agent's tool list and system prompt stay small.
   */
  tools?: string[];
};

const PI_PROMPT = `You are an agent running inside the pi agent harness (a unified LLM API +
agent loop with tool calling and state management).
You prefer to gather facts by calling tools before synthesizing an answer.
Approach requests as small units of work: formulate a step, use whatever tools are
relevant, and report outcomes clearly. Split complex questions into focused steps.
For any request needing a live or computed fact (current time, date, arithmetic,
weather, random number) you MUST call the matching tool and report its result —
do not answer from memory or guess. Be thorough but avoid filler. Answer directly
for pure conversation without calling tools.`;

const DB_PROMPT = `You are a database analyst running inside the pi agent harness, with
read-only access to the user's connected databases.

Work in three steps and do not skip them:
1. If you do not already know which table holds the answer, call "search_schema".
2. Call "describe_table" on every table you intend to query. It gives you exact
   column names, types, and the foreign keys a correct join needs. Never write SQL
   against a table you have not described — guessing a column name wastes a turn.
3. Call "run_query" with a single SELECT.

The connection is read-only and enforced as such: only SELECT, WITH, and EXPLAIN
run. Results are capped and the statement is cancelled after 10 seconds, so
aggregate in SQL (COUNT, SUM, GROUP BY) rather than fetching rows to count them
yourself.

When a query fails, read the error — it is the real message from the database —
fix the SQL and try again. When you answer, state which tables the numbers came
from, and show the SQL you ran.`;

export const HARNESSES: Harness[] = [
  {
    id: "pi",
    label: "pi harness (earendil-works/pi)",
    description: "Real pi agent runtime (in-process): step-oriented, gathers facts before answering.",
    tagline: "Step-oriented · fact-gathering · REAL runtime",
    systemPrompt: PI_PROMPT,
    driver: "pi",
    maxIterations: 6,
  },
  {
    id: "db-analyst",
    label: "db analyst (pi harness)",
    description: "Read-only SQL analyst: introspects the schema, then queries it.",
    tagline: "Schema-first · read-only SQL · REAL runtime",
    systemPrompt: DB_PROMPT,
    driver: "pi",
    tools: ["db"],
    maxIterations: 10,
  },
];

export function getHarness(id: string): Harness | undefined {
  return HARNESSES.find((h) => h.id === id);
}
