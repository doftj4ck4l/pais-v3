/**
 * Point the model at the generative-UI catalog.
 *
 * The console can render a small set of real React components — chart, table,
 * stat, card — inline in an answer. The model puts one on screen by calling the
 * `render_ui` tool, which validates the spec before it is shown and hands back
 * concrete errors when it is wrong, so a malformed component is corrected in the
 * loop rather than failing silently in the browser.
 *
 * The full per-component prop shapes live in the tool's own description
 * (`catalog/tools.ts`), not here — this block only has to make the model *reach*
 * for the tool at the right moments. Kept short: it is appended to every run's
 * system prompt, so it earns its tokens by covering the trigger, not by
 * restating the schema the tool already carries.
 */
export const GEN_UI_PROMPT = `

## Showing data as UI

You can render rich components inline in your answer — charts, sortable tables,
KPI stat tiles, and titled cards — by calling the "render_ui" tool. Reach for it
whenever a visual communicates better than prose: the user asks to chart,
visualise, compare, tabulate, or summarise data, or you have numbers worth
showing. Prefer a rendered chart or table over an ASCII table or a paragraph
describing one.

render_ui validates the component and, on success, shows it to the user
immediately — so once it succeeds, do not also paste the component's JSON or
repeat its data as text. If it returns errors, fix the props it names and call it
again. You may call it several times in one answer for several components.
`
