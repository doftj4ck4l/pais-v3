# Cline harness — design

Date: 2026-08-04
Status: approved, not yet implemented

## Problem

`HARNESSES` has one entry. The console is built around a harness × model matrix
— "pick a harness and a model; each combination runs the same loop" — but with a
single harness there is nothing to compare. `Harness.driver` is already typed
`"prompt" | "pi"`, so a second runtime is the extension point the design
anticipated.

Cline released its agent runtime as a standalone SDK (`@cline/sdk`, Apache-2.0),
which is the same loop behind their VS Code extension and CLI. It is a genuine
second opinion on how an agent loop should work, rather than a variation on the
same prompt.

## Verified before designing

All of this was checked against `@cline/sdk@0.0.69` on this machine, not read
from documentation.

| Question | Result |
| --- | --- |
| Runs under Bun? | Yes. `agent-base@6` logs a CJS-interop error at import; non-fatal, the run completes. |
| Works against our gateway? | Yes. `providerId: "openai-compatible"` + `baseUrl` + `apiKey` returned a correct completion from `qwen3.5-397b-instruct`. |
| Custom tools? | `AgentRuntimeConfig.tools?: readonly AgentTool<any, any>[]` |
| Seeded history? | `initialMessages`, plus `restore(messages)` for re-seeding from storage |
| Shell/file injection? | `ToolExecutors` exposes `bash`, `readFile`, `editor`, `applyPatch`, `search`, `webFetch` |
| Token usage? | `usage-updated` event and `usage` on the run result — provider-reported |

Observed event types from a real run:

```
run-started, message-added, turn-started, assistant-text-delta,
usage-updated, assistant-message, turn-finished, run-finished
```

Result shape: `{ agentId, agentRole, runId, status, iterations, outputText, messages, usage }`

Relevant signatures:

```ts
type ShellExecutor = (command: string | StructuredCommandInput, cwd: string, context: AgentToolContext) => Promise<string>
type FileReadExecutor = (request: ReadFileRequest, context: AgentToolContext) => Promise<FileReadResultContent>
type EditorExecutor = (input: EditFileInput, cwd: string, context: AgentToolContext) => Promise<string>
```

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Integration depth | Full parity | Cline runs our tools *and* its shell/file tools go through our sandbox. If the two harnesses had different tools, any observed difference could be the harness or the tools, and you could not tell which. |
| Provider | `openai-compatible` | Same gateway as pi. No second credential path. |
| `webFetch` / `search` executors | Left unset | We already expose `web-fetch` and `web-search` as skills. Two routes to the same capability would make the comparison meaningless. |
| Cline types | Confined to `cline.service.ts` | 0.0.69 is pre-1.0 and will churn; a breaking release should touch one file. |
| Context metering | Prefer reported usage | Cline reports real prompt tokens. The pi path estimates by character count, so the meter is more accurate on this harness. |

## Architecture

Mirrors `pi.service.ts` exactly, so dispatch stays a one-line branch.

```
agent.service.ts
  └─ harness.driver === "pi"     → runPiAgent(...)
  └─ harness.driver === "cline"  → runClineAgent(...)      ← new

cline.service.ts                 (the only file that imports @cline/sdk)
  ├─ provider   openai-compatible + ModelConfig.baseUrl / apiKey
  ├─ tools      TOOLS + memory + document + call_skill, adapted to AgentTool
  ├─ executors  bash / readFile / editor  →  DockerExecutionEnv
  ├─ history    initialMessages ← threaded history
  └─ subscribe  Cline events → AgentEvent
```

`runClineAgent` takes the same options object as `runPiAgent` (`model`,
`systemPrompt`, `history`, `emit`, `signal`, `runId`, `workspace`, `userId`) and
returns the same `Promise<number>` of turns. Anything that can be shared between
the two drivers — sandbox acquisition, tool construction, the docs prompt — moves
to a helper rather than being copied, since duplicated wiring is how the two
harnesses would silently drift apart and stop being comparable.

### Event mapping

| Cline | AgentEvent |
| --- | --- |
| `assistant-text-delta` | `text` |
| `turn-started` | `iteration` |
| tool start / end | `tool_call` / `tool_result` (with `ms` and `ok`, as the pi path now does) |
| `usage-updated` | `context` (real `used`, window from the catalog) |
| `run-finished` | `done` |
| runtime error | `error` |

Tool timing is measured the same way as the pi path: start times keyed by tool
call id, not name, because parallel calls to one tool overlap.

### Sandbox

Executors close over the `DockerExecutionEnv` already built for the run:

```ts
bash: (command, cwd) => execEnv.exec(String(command), { cwd })
```

Filesystem executors go through the same env, so the workspace confinement added
in `68e2411` applies unchanged — Cline gets no path the pi harness does not.
Skills are unaffected: `call_skill` is passed in as a tool and already routes
through `ExecutionEnv`.

## Catalog

A second `HARNESSES` entry with `driver: "cline"`, its own system prompt, and its
own `maxIterations`. The prompt should describe Cline's actual style rather than
copying pi's, since the prompt is half of what is being compared.

## Error handling

- SDK import or construction failure → an `error` event on the stream, matching
  how a bad model is reported. The console renders it inline; it must not take
  down the pi harness.
- Cline reports failures through its own event stream; those map to `error`
  rather than throwing, consistent with the pi path.
- The `agent-base` load error is noise from a transitive dependency. It should be
  left alone rather than suppressed — swallowing library stderr hides real
  failures later.

## Testing

- Event mapping: a unit test driving the mapper with recorded Cline events,
  asserting the `AgentEvent` sequence. No network, no model.
- Executor adapters: assert `bash` delegates to `ExecutionEnv.exec` with the
  right cwd, using a fake env.
- End to end (needs Docker and the gateway): the same question on both harnesses,
  producing an answer and a non-empty transcript on each.

## Risks

1. **`0.0.69` is pre-1.0.** Expect breaking changes. Containment in one file is
   the mitigation.
2. **296 packages**, including AWS and SAP provider SDKs that will never be used.
   Install size and audit surface both grow.
3. **Noisy import error** in every boot log.
4. **Cline may expect a workspace** in ways not yet exercised — only a trivial
   prompt has been run so far. The first real tool-using run is where that would
   surface.

## Out of scope

- Cline's agent teams, plugins, hooks, and checkpointing.
- Its `webFetch` and `search` executors.
- Replacing the pi harness. Both run side by side; that is the point.
