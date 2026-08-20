# Reference projects

Directories under `references/` are git submodules pinned to upstream
commits. They are kept for reading and study — nothing here is imported
into `apps/` or compiled into the build, so future agents (human or AI)
can consult the upstream source without a network round-trip.

| Clone | Upstream | Pinned commit | Why we keep it |
|-------|----------|---------------|----------------|
| `deepseek-harness/` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `141eb6f` | DeepSeek's open-source agent harness (`dsh`), plugin-first architecture ("everything is a plugin"), developer preview `0.1.0-rc.8`. The reference point for a newer-methodology agent harness when we revisit the harness × model matrix (see `docs/superpowers/specs/2026-08-04-cline-harness-design.md`). |
| `paper/` | [cordiverse/paper](https://github.com/cordiverse/paper) | `948a07b` | The formal paper *A Programming Paradigm for Spatiotemporal Composability* (Aug 2026 preprint) — the design behind [Cordis](https://github.com/cordiverse/cordis), which `deepseek-harness` runs on. Read it when reasoning about revertible effects, reactive coeffects, or dynamic composition of agent components. |

## How the pins are kept current

Pinned commits are bumped deliberately, by hand, because `dsh` is
pre-1.0 and its README warns of compatibility-breaking changes; the
paper is a preprint under active revision.

```bash
# Move a reference to the current upstream default-branch HEAD, then
# review `git submodule status` and commit the new pin:
git submodule update --remote references/deepseek-harness
git submodule update --remote references/paper
```

## Cloning with the references

A normal clone leaves these directories empty; fetch them with:

```bash
git submodule update --init --recursive
```
