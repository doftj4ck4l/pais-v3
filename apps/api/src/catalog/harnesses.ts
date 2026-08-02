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
];

export function getHarness(id: string): Harness | undefined {
  return HARNESSES.find((h) => h.id === id);
}
