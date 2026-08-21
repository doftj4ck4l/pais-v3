# Agent capability-discovery improvements (from DGX Spark traces)

Status: **plan / not started.** Source: `app.db` on the DGX Spark box
(`pixelspace-api-1`), 2026-08-21 — 9 runs, 375 traces, 57 tool calls. Read from
the `traces` table (`step='tool'`, `fields` JSON: name/ok/args/result).

## The core problem

Almost every failure in the traces is the same shape: **the model hunts for a
capability it can't find** — a tool that's actually a skill, a library the
sandbox doesn't have and can't install, a shell that isn't the one it's named
after. Each hunt burns several turns before the model stumbles onto the real
path (or gives up and hacks around it). Counts from this sample: bash 7 fails,
`web-search`-as-tool 2 fails, write 1 fail, one skill-arg probe fail, one
container-reaped crash, and a 6-call empty-search loop.

## Findings (each backed by a trace)

### 1. `web-search` is a skill, not a tool — the model can't find it
The model called the bare tool `web-search` → `"Tool web-search not found"`
(2×), then discovered it works as `call_skill("web-search")`. Wasted calls
learning the indirection; then it used it heavily.

### 2. Sandbox is missing common tooling and can't self-install
One quotation/PDF run tried, in order:
`ps2pdf` → *not found* · `python3 -c "from fpdf import FPDF"` → *ModuleNotFound*
· `reportlab` → *ModuleNotFound* · `pip install fpdf2` →
**`error: externally-managed-environment`** · `curl` → *not found*.
Seven dead ends before it fell back to the `docx` skill. `pip` is blocked by
PEP 668, so the model literally cannot install its way out.

### 3. The `bash` tool runs `sh` (dash), not bash
`grep ... <<< "$(...)"` → `sh: 1: Syntax error: redirection unexpected`. The
tool is named "bash" but here-strings and other bashisms fail.

### 4. Skill argument schemas aren't discoverable
First `call_skill("docx", …)` → `skill "docx" exited 1: "path" is required, e.g.
"report.docx"`, then a retry with `path` succeeded. The model learns required
args only by failing once per skill.

### 5. Empty search → reformulation loop
6 near-identical `web-search` queries ("Takaful Malaysia Q2 2026" → "2025" →
"2024 fourth quarter" → …), all `no results`. Classic thrash; nothing stops it.

### 6. Sandbox reaped mid-run
A later `call_skill` died with
`Error response from daemon: No such container: 0392…` — the container was
removed while the run was still active. Reliability bug, not model behaviour.

### 7. Execution-context confusion
The model tried to call `fetch_url` (an API-side tool) *inside* bash, and tried
to `write` to `/tmp/q4_2025_report.pdf` → rejected ("outside the sandbox
workspace"). It doesn't have a clear model of what runs where.

## Proposed fixes (ranked by impact ÷ effort)

| # | Fix | Addresses | Likely location |
|---|-----|-----------|-----------------|
| 1 | **Make `web_search` a first-class tool** (thin wrapper over the existing skill) | #1 | `catalog/tools.ts` + skill runner |
| 2 | **Bake tooling into the sandbox image + allow installs**: add `curl`, `ghostscript`, a PDF lib (reportlab/weasyprint); give a writable venv or permit `pip --break-system-packages` | #2 | sandbox `Dockerfile`, `services/.../docker.ts` |
| 3 | **Run the `bash` tool under real bash** (install bash, `exec bash -c`) | #3 | sandbox image + docker exec invocation |
| 4 | **Advertise skill input schemas** (required args) in `call_skill` / the skill catalog, or return a structured "missing arg" before executing | #4 | skill catalog / `call_skill` tool |
| 5 | **Don't reap a sandbox with an active run; recreate on `ENOENT`** | #6 | sandbox reaper / `sandbox.acquire` (`reapIdle`) |
| 6 | **Runtime nudge on search thrash**: after N empty/near-duplicate searches, tell the model to stop and ask the user or use a URL. The `searching` signal in `playbook/signals.ts` already detects this — surface it mid-run, not only to the reflector | #5 | `playbook/signals` + run loop (`pi.service.ts`) |
| 7 | **System-prompt clarifications**: the three execution contexts (bash = sandbox; `fetch_url`/`web_search`/skills = API-side), the writable workspace path, and a one-line inventory of what the sandbox ships with | #2/#3/#7 | system prompt assembly |

## Suggested first cut

**#1 + #2 + #7** together remove the large majority of wasted calls in the
sample (`web_search` becomes findable, the sandbox stops being a dead end, and
the prompt stops the context confusion). **#1 and #7 are small.** **#5 (the
reaped-container crash) is a real reliability bug** worth doing regardless of the
capability work.

## Follow-ups before implementing

- Pull the full turn-by-turn transcript of the quotation run (messages +
  reasoning) to see the exact hacking between the failed calls.
- Confirm the current sandbox image contents and whether a writable venv already
  exists before choosing the install approach for #2.
- Check whether `web-search` results quality (#5) is a backend limitation or a
  query-shaping one.
