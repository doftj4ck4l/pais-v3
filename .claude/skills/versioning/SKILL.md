---
name: versioning
description: Use whenever committing changes, bumping the version, or cutting a release in this repo. Establishes that Pixelspace uses SemVer (repo-root VERSION file) and Conventional Commits, and how to bump each on a change.
---

# Versioning & commits

This repo ships to on-prem / airgapped customers, so version discipline matters:
a customer's `0.4.2` must mean exactly one thing. Two conventions, always.

## 1. SemVer — one source of truth: the repo-root `VERSION` file

Current line is **0.x** (pre-1.0): the API is still stabilising, so a MINOR may
carry a breaking change — call it out in the commit body and `CHANGELOG` when it
does. Keep `MAJOR` at `0` until the product is declared stable, then cut `1.0.0`.

`MAJOR.MINOR.PATCH`:

| Part | Bump when | Example |
| --- | --- | --- |
| **PATCH** | bug fix, no new behaviour, no schema change | `0.1.0 → 0.1.1` |
| **MINOR** | new feature / capability, backward compatible | `0.1.1 → 0.2.0` |
| **MAJOR** | breaking change; post-1.0, an incompatible schema migration | `0.9.0 → 1.0.0` |

**Bumping:** edit `VERSION` (e.g. `printf '0.2.0\n' > VERSION`) in the same
change that earns the bump. That file is the single source — the API bakes it
into its image and reports it at `GET /api/meta`; `scripts/pixelspace`
(`status`/`doctor`/`upgrade`) reads it and **refuses a downgrade**. So never move
`VERSION` backward, and bump it whenever a change would ship to a deployment.

Not every commit needs a bump — bump when you cut a release / would deploy, not
on every intermediate commit. If unsure whether a change is MINOR or PATCH and it
adds any user-visible capability, it's MINOR.

## 2. Conventional Commits — every commit

`type(scope): summary`, imperative, lower-case, no trailing period.

Types: `feat` (MINOR), `fix` (PATCH), `docs`, `refactor`, `test`, `chore`,
`build`, `ci`, `perf`. A breaking change adds `!` (`feat(api)!: …`) and a
`BREAKING CHANGE:` line in the body — that's a MAJOR.

Scope is the area: `installer`, `agent`, `deploy`, `web`, `api`, `models`,
`versioning`, etc. Body explains **why**, wraps ~72 cols. Keep this repo's
footer:

```
feat(installer): add offline release bundle

<why, not what>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## The two together, on a change that ships

1. Make the change.
2. Bump `VERSION` per the table (skip if it doesn't ship).
3. Commit with a Conventional Commit whose type matches the bump
   (`feat` ↔ MINOR, `fix` ↔ PATCH).
4. Tag the release `vX.Y.Z` when merging to the release line.

See `docs/plans/versioning.md` for the full scheme and the upgrade flow.
