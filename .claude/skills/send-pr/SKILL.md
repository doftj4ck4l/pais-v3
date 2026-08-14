---
name: send-pr
description: Use when the user says "send a PR", "open a PR", "submit a PR", "raise a PR", or asks to get finished branch work reviewed. Covers this repo's Forgejo remote, where `gh` does not work and there is no API token.
---

# Send a PR

PRs for this repo go to **Forgejo**, opened by an **AGit push over SSH**. No API
token is needed and none is available — do not go looking for one, and do not
reach for `gh`.

## Why the obvious routes fail

`git remote -v` lists three remotes and only one is live:

| Remote | Where | Use it? |
| --- | --- | --- |
| `origin` | `ssh://git@10.45.154.236/nextplus/pixelspacev3.git` (`git.internal.mycip.com.my`) | **Yes.** `main` lives here; PRs merge here. |
| `github` | `farhan-helmy/salur` | No. Stale and unrelated — its `main` was `0ec4c3b` while Forgejo's was `f4078b7`. |
| `internal` | `farhan/salurai.git` | No. The old name. |

`gh` is installed and authenticated, but it only speaks to GitHub, so it cannot
open a PR here — a `gh pr create` will either fail or, worse, succeed against
the wrong repository. There is no Forgejo token in the environment or in
`~/.git-credentials`, and the repo is private, so anonymous API reads are
refused too: a PR here can be **created but not read back**.

## Opening one

```bash
git push origin HEAD:refs/for/main \
  -o topic=<branch-name> \
  -o title="..." \
  -o description="..."
```

Forgejo answers with the PR URL. `refs/for/main` targets `main`; `topic` is what
distinguishes one PR from another on the same target, so use the branch name.

Pushing the branch normally first (`git push -u origin <branch>`) is optional —
it makes the branch visible on its own, and Forgejo prints a compare URL the
user can click if the AGit push is refused.

## The two traps

- **Push options must not contain newlines.** A multi-line `-o description=`
  fails with `fatal: push options must not have new line characters`, before
  anything reaches the server. Keep the description to one paragraph on one
  line and let the commit messages carry the detail — they are the durable
  record anyway.
- **"Visit the existing pull request" is not "created".** Forgejo says that when
  the topic already has a PR, and `-o title`/`-o description` apply only at
  creation. The commits still land on the PR head, but the title and body may be
  whatever the first push set. Say so rather than claiming the description
  landed — there is no way to read it back without a token.

## After

**Do not merge.** `.forgejo/workflows/deploy.yml` fires on every push to `main`,
so merging is a release. Hand the user the URL and let them decide.

Before sending, the branch should already be green the way CI is green — see
`CLAUDE.md` for the exact test command, and the `deploy` skill for exercising
the change in the running stack.
