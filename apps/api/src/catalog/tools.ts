export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => string | Promise<string>;
};

export const TOOLS: Tool[] = [
  {
    name: "calculator",
    description:
      "Evaluate a simple arithmetic expression. Supports + - * / and parentheses. Returns the numeric result as a string.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "e.g. (2 + 3) * 4",
        },
      },
      required: ["expression"],
    },
    run: (args) => {
      const expr = String(args.expression ?? "").trim();
      if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
        return "error: expression contains unsupported characters";
      }
      try {
        const value = Function(`"use strict"; return (${expr});`)();
        return `calculator(${expr}) = ${value}`;
      } catch (e) {
        return `error evaluating expression: ${(e as Error).message}`;
      }
    },
  },
  {
    name: "get_current_time",
    description:
      "Return the current date and time, both as ISO 8601 UTC and formatted for GMT+8 (Malaysia / Asia/Kuala_Lumpur).",
    parameters: { type: "object", properties: {} },
    run: () => {
      const now = new Date();
      const gmt8 = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kuala_Lumpur",
        dateStyle: "full",
        timeStyle: "medium",
      }).format(now);
      return `UTC: ${now.toISOString()}\nGMT+8 (Malaysia): ${gmt8}`;
    },
  },
  {
    name: "echo",
    description: "Echo back the provided text. Useful for testing.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    run: (args) => String(args.text ?? ""),
  },
  {
    name: "random_number",
    description:
      "Generate a random integer between min and max inclusive. Defaults to 1–100.",
    parameters: {
      type: "object",
      properties: {
        min: { type: "number", description: "lower bound, default 1" },
        max: { type: "number", description: "upper bound, default 100" },
      },
    },
    run: (args) => {
      const min = Math.ceil(Number(args.min ?? 1));
      const max = Math.floor(Number(args.max ?? 100));
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        return "error: min/max must be finite numbers with min <= max";
      }
      const value = Math.floor(Math.random() * (max - min + 1)) + min;
      return `random_number(${min}..${max}) = ${value}`;
    },
  },
  {
    name: "get_weather",
    description:
      "Return the current weather for a city. Returns a deterministic mock forecast — no live API.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "city name, e.g. Kuala Lumpur" } },
      required: ["city"],
    },
    run: (args) => {
      const city = String(args.city ?? "Unknown").trim() || "Unknown";
      const conditions = ["sunny", "partly cloudy", "rainy", "thundery", "humid haze"];
      const hash = [...city].reduce((a, c) => a + c.charCodeAt(0), 0);
      const condition = conditions[hash % conditions.length];
      const temp = 22 + (hash % 13);
      return `weather(${city}): ${condition}, ${temp}°C, humidity ${45 + (hash % 40)}%`;
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch a URL over HTTP(S) and return the first ~1000 chars of the response body (as text). Useful for looking up live info.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "absolute http(s) URL to fetch" } },
      required: ["url"],
    },
    run: async (args) => {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\/.+/i.test(url)) return "error: must be an absolute http(s) URL";
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return `error: fetch_url returned HTTP ${res.status}`;
        const text = await res.text();
        return `fetch_url(${url}) returned ${res.status}, ${text.length} chars:\n${text.slice(0, 1000)}`;
      } catch (e) {
        return `error fetching ${url}: ${(e as Error).message}`;
      }
    },
  },
];

export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `error: unknown tool "${name}"`;
  try {
    return await tool.run(args ?? {});
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
