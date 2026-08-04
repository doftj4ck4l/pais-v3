# Office document skills — design

Date: 2026-08-03

## Problem

The agent can read PDFs (context layer) but cannot produce anything. Asked for a
spreadsheet or a Word document, it has no way to make one, and no way to hand it
back if it did.

Two things block it:

1. **`call_skill` runs on the API host.** `invokeSkill()` shells out with
   `execFile("node", [script])`, bypassing `ExecutionEnv` entirely. The Docker
   sandbox covers `bash`/`read`/`write`/`edit` via `toolContext.env`; skills are
   not covered. Skills are also the extension point — third-party skills would
   execute as the server's user with its environment, including `CUSTOM_API_KEY`.
2. **Nothing leaves the workspace.** There is no endpoint that serves a file the
   agent produced. A generated `report.xlsx` sits in `SANDBOX_ROOT/<userId>/`
   and the console cannot reach it.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Runtime | Local Docker | Already built, free, working. Cloudflare Sandbox needs a Workers Paid plan and cannot be called from a Bun host — Workers-only bindings. |
| Skill delivery | Bind-mount read-only | Edit a skill and rerun, no image rebuild. Container cannot modify its own skills. |
| Image contents | node + JS libs + Python + openpyxl | openpyxl round-trips real-world spreadsheets better than JS, and OpenClaw's skills are Python so they port more directly. |
| Format conversion | Out of scope | LibreOffice adds 600MB–1GB. Accepted limit: create PDFs from scratch, no `docx→pdf`. |
| Skills on `node` backend | Refuse | Falling back to the host is the hole being closed. Same stance the sandbox already takes when Docker is down. |

## Architecture

pi stays on the host. Only tool execution crosses into the container.

```
HOST                                          CONTAINER salurai-<userId>
  Bun API
    pi AgentHarness
      ├── model call ──HTTPS──► gateway
      ├── search_docs/remember   (in-process, SQLite)
      ├── bash/read/write/edit ──┐
      └── call_skill ────────────┤  toolContext.env = DockerExecutionEnv
                                 └──docker exec──► /workspace  (rw, bind-mounted)
                                                   /skills     (ro, bind-mounted)
```

### Skill execution

`invokeSkill()` takes an `ExecutionEnv` instead of importing `child_process`.
The interpreter comes from the skill, not from hardcoded `node`:

```markdown
---
name: xlsx
description: Create and edit .xlsx spreadsheets.
run: python3 xlsx.py
---
```

Absent `run:`, the existing `node <name>.cjs` convention is assumed, so
`web-fetch` and `web-search` keep working unchanged.

The mount path is fixed at `/skills` inside the container so a skill's command
is independent of where the repo sits on the host.

### Module boundaries

- `skill.service.ts` — loading and invocation; the only place that knows how a
  skill is launched. Takes `ExecutionEnv`, so it is testable with a fake.
- `workspace.repository.ts` — resolves and validates paths under
  `SANDBOX_ROOT/<userId>`. The only module that turns a request path into a real
  path.
- `workspace.controller.ts` — HTTP in/out only.

### Download path

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/workspace/files?userId=` | List files in the user's workspace |
| GET | `/api/workspace/files/:path?userId=` | Download one file |

The endpoint serves a directory an agent writes to, so path handling is the
whole risk surface:

- `path.resolve()` the joined path, then require it to be prefixed by the user's
  workspace root — rejects `../` traversal.
- `fs.realpath()` and re-check the prefix — rejects a symlink the agent planted
  pointing at `/etc/passwd`.
- Reject absolute paths and any segment equal to `..` before touching the disk.
- `Content-Disposition: attachment` always, so a generated `.html` is downloaded
  rather than rendered in the console's origin.

## Error handling

- Skill invoked on the `node` backend → returns an error naming the reason, not
  a silent host fallback.
- Skill exits non-zero → stderr returned to the model so it can correct itself.
- Download of a missing or rejected path → 404, with no distinction between
  "absent" and "outside the workspace", so the endpoint is not a probe for
  host filesystem layout.

## Testing

- Path guard: unit tests for `../`, absolute paths, symlink escape, and a valid
  nested path. These run without Docker.
- Skill interpreter resolution: unit test that `run:` is honoured and that its
  absence falls back to `node <name>.cjs`.
- End to end (needs Docker): the agent is asked for a spreadsheet, the file
  appears in the workspace listing, and downloading it returns a valid xlsx.

## Out of scope

- `docx→pdf` and any other format conversion (no LibreOffice).
- Uploading files *into* the workspace — the context layer already handles
  document ingest, and a write path is a separate risk surface.
- Cloudflare/E2B/Fly backends. Routing skills through `ExecutionEnv` is what
  makes those a single new class later; none is built now.
