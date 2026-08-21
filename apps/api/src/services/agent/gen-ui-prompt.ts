/**
 * Teach the model the console's generative-UI catalog.
 *
 * The chat renders assistant markdown, and inside that markdown it also renders
 * a small set of real React components when the model emits a fenced ```ui
 * block carrying a JSON spec. This is the model's side of that contract: the
 * component names, their props, and when to reach for one instead of prose.
 *
 * The frontend validates every block against this same catalog before it
 * renders (`apps/web/.../lib/ui-blocks.ts`); a block that does not match is
 * dropped to a small placeholder, so an over-eager or malformed block degrades
 * quietly rather than breaking the answer. Keep this description and that
 * validator in step — a prop named here that the validator rejects is a block
 * the user never sees.
 *
 * Deliberately compact. It is appended to every run's system prompt, so it earns
 * its tokens by covering the common case (charts, tables, KPIs) and trusting the
 * model to fall back to prose for everything else.
 */
export const GEN_UI_PROMPT = `

## Rendering data as UI

The chat console can render live React components inline in your answer. When the
user asks to visualise, compare, chart, tabulate, or summarise data — or whenever
a chart or table communicates better than prose — emit a fenced code block tagged
\`ui\` containing a single JSON object: \`{ "component": <name>, "props": { ... } }\`.
Write normal markdown around it; you may emit several blocks in one answer. Do not
draw ASCII tables or describe a chart in words when you can render one. Only use
the components and props below — anything else is dropped silently.

**chart** — props: \`type\` ("bar" | "line" | "area" | "pie" | "scatter"), \`data\`
(array of row objects), \`x\` (the category key on every row), \`y\` (one metric key,
or an array of keys for multiple series), optional \`title\`.

\`\`\`ui
{ "component": "chart", "props": { "type": "bar", "title": "Revenue by quarter",
  "x": "quarter", "y": ["online", "retail"],
  "data": [ { "quarter": "Q1", "online": 42, "retail": 30 },
            { "quarter": "Q2", "online": 55, "retail": 28 } ] } }
\`\`\`

**table** — props: \`columns\` (array of \`{ key, label?, align? }\`, align is
"left" | "right" | "center"), \`rows\` (array of row objects keyed by column key),
optional \`caption\`. Columns are sortable in the UI.

\`\`\`ui
{ "component": "table", "props": {
  "columns": [ { "key": "name", "label": "Product" },
               { "key": "sold", "label": "Units", "align": "right" } ],
  "rows": [ { "name": "Widget", "sold": 1240 }, { "name": "Gadget", "sold": 880 } ] } }
\`\`\`

**stat** — a single KPI tile. props: \`label\`, \`value\`, optional \`delta\`,
optional \`trend\` ("up" | "down" | "flat"), optional \`help\`. Emit several in a row
for a KPI strip.

\`\`\`ui
{ "component": "stat", "props": { "label": "MRR", "value": "$48.2k", "delta": "+12%", "trend": "up" } }
\`\`\`

**card** — a titled panel. props: optional \`title\`, optional \`body\` (markdown),
optional \`fields\` (array of \`{ label, value }\`), optional \`accent\`
("default" | "primary" | "success" | "warning" | "destructive").

\`\`\`ui
{ "component": "card", "props": { "title": "Summary", "accent": "success",
  "body": "Migration completed with **no errors**.",
  "fields": [ { "label": "Rows moved", "value": "12,904" }, { "label": "Duration", "value": "3.2s" } ] } }
\`\`\`
`
