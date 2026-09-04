import { validateUiSpec } from "../services/agent/ui-catalog";

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
    name: "render_ui",
    description:
      "Render a rich UI component inline in your answer to the user: a chart, a sortable table, a KPI stat tile, or a titled card. " +
      "Call this whenever a visual communicates better than prose — the user asks to chart, compare, tabulate, or summarise data, or you have numbers worth showing. " +
      "The component is validated here before it is shown; on success it is already visible to the user, so do not also paste its JSON into your reply. " +
      "On failure this returns the exact problems — fix the props and call render_ui again. You may call it several times for several components.\n\n" +
      "Component props:\n" +
      "- chart: type ('bar'|'line'|'area'|'pie'|'scatter'), data (array of row objects), x (category key on every row), y (one metric key or an array of keys), title?, color? (single colour for the whole chart — hex, rgb()/hsl(), or a CSS name like 'orange'), colors? (array of colours, one per series or pie slice) \n" +
      "- table: columns (array of { key, label?, align? } where align is 'left'|'right'|'center'), rows (array of row objects keyed by column key), caption? \n" +
      "- stat: label, value, delta?, trend? ('up'|'down'|'flat'), help? \n" +
      "- card: title?, body? (markdown), fields? (array of { label, value }), accent? ('default'|'primary'|'success'|'warning'|'destructive')",
    parameters: {
      type: "object",
      properties: {
        // Deliberately loose (no enum, no nested object schema): a strict schema
        // makes pi reject a weak model's stringified argument with an opaque
        // "must be equal to constant" the model cannot act on. render_ui's own
        // validator coerces and returns a fixable error instead.
        component: {
          type: "string",
          description: "which catalog component to render: chart, table, stat, or card",
        },
        props: {
          description: "the component's fields as a JSON object (see the tool description for each component's shape)",
        },
      },
      required: ["component", "props"],
    },
    run: (args) => {
      const result = validateUiSpec(args.component, args.props);
      if (!result.ok) {
        // The model reads this and retries — the whole point of validating here
        // rather than letting the block fail silently in the browser.
        return `render_ui rejected this ${String(args.component)}:\n- ${result.errors.join("\n- ")}\nFix these and call render_ui again.`;
      }
      // The console renders the component from this call's arguments; the tool
      // only has to confirm it validated. Kept short so it costs little when the
      // transcript replays it on the next turn.
      return `Rendered the ${String(args.component)}. It is now visible to the user — do not repeat its data as text.`;
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
