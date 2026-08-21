# Versioning & on-prem updates

How a Pixelspace deployment (DGX Spark, customer env) knows what it runs and how
it moves to a new release. One codebase, two channels (internal continuous
deploy; customer packaged release) — already separated at the Compose-project
level.

## Scheme: SemVer, one source of truth

`MAJOR.MINOR.PATCH` in the repo-root **`VERSION`** file.

- **MAJOR** — breaking change / schema migration that isn't backward compatible.
- **MINOR** — new features, backward compatible.
- **PATCH** — fixes.

The file is the single source, read two ways:

- **App** (`apps/api/src/lib/version.ts`) — the `VERSION` baked into the API
  image (Dockerfile `COPY VERSION`) wins, so the running container always reports
  the version of the code it is actually running. Surfaced at `GET /api/meta`.
- **Installer** (`scripts/pixelspace` `read_app_version`) — reads the checkout's
  `VERSION`, records the installed version as `PIXELSPACE_VERSION` in the
  deployment env for its own tracking (the app ignores it — the baked file wins).

## Done (this branch)

- `VERSION` file (`0.1.0`; MAJOR stays `0` until the product is declared
  stable), baked into the API image, reported at `/api/meta`.
- `pixelspace status` / `doctor` print the installed version and flag when the
  checkout provides a newer one.
- `pixelspace upgrade` prints the `X -> Y` transition, **refuses a downgrade**,
  and records the new version only after refresh + health pass.
- Tests: installer (record/status/downgrade/transition) and API (`/api/meta`
  carries a semver version).

## The two update channels (mechanism already exists)

- **Build mode (DGX / has source):** fetch the release (`git checkout vX.Y.Z` or
  an extracted tarball) → `pixelspace upgrade`. `refresh_stack` rebuilds
  api/web/sandbox. The downgrade guard uses the checkout's `VERSION`.
- **Image mode (airgapped customer):** update the digest-pinned image refs in
  `.env` → `pixelspace upgrade`, which pulls/loads and recreates. No registry or
  internet needed once the images are present.

## Next slice: the airgapped release bundle

Turn "update the digest refs by hand" into a first-class artifact.

1. **`release` step** (CI on a git tag `vX.Y.Z`): build multi-arch images, then
   `docker save` api/web/sandbox (+ pinned rustfs/model) into
   `pixelspace-<version>-<arch>.tar`, alongside a manifest of the digests, the
   installer, and the compose file. Also publish for connected installs.
2. **`pixelspace update --bundle <file.tar>`**: verify the manifest, `docker
   load` the images, set the digest refs + `PIXELSPACE_VERSION`, then run the
   existing `upgrade` (doctor → backup → refresh → health, with rollback).
3. **`CHANGELOG.md`** per release; `upgrade` points at the notes for `X -> Y`.

## Safety rails (mostly already present)

- `upgrade` backs up first; `restore` has a safety backup + auto-rollback.
- Schema migrations are forward-only and run at boot (`ensureSchema`).
- Add later: gate a **MAJOR** jump behind an explicit `--allow-major`, and a
  compatibility note per release.
