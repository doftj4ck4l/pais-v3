# Pixelspace on-prem installation

Pixelspace ships as a single-host Docker Compose appliance. The application
stack stays independent from model inference: point it at an existing
OpenAI-compatible gateway rather than letting the installer consume a GPU or
replace a model service the host already runs.

The first supported host contract is:

- Linux on `amd64` or `arm64`
- Docker Engine with Docker Compose v2
- a local filesystem for Pixelspace state (not NFS)
- outbound access to build/pull images and dependencies, unless images have
  already been loaded for an offline installation
- an existing OpenAI-compatible model endpoint

The installer does not add operating-system repositories, modify the firewall,
or install Docker with root privileges. Those are host-administration choices,
not application installation details.

## Install

From a release checkout:

```bash
./install.sh \
  --admin-email operator@example.com \
  --model-url https://gateway.example.internal/v1 \
  --model-id my-model
```

The default `local` authentication mode prompts twice for the first
administrator password. The password is Argon2id-hashed in Pixelspace's SQLite
database; it is never written to an environment file or passed as a process
argument. Automation can provide a protected file instead:

```bash
chmod 600 /secure/pixelspace-admin-password
./install.sh \
  --admin-email operator@example.com \
  --admin-password-file /secure/pixelspace-admin-password \
  --model-url https://gateway.example.internal/v1 \
  --model-id my-model
```

The generated `.env` is mode `600`. Persistent state defaults to
`$XDG_DATA_HOME/pixelspace` or `~/.local/share/pixelspace`, with backups under
`~/pixelspace-backups`. Re-running the command preserves existing secrets and
data.

The default security posture is intentionally local:

```text
WEB_BIND_ADDRESS=127.0.0.1
AUTH_MODE=local
```

That is suitable for a workstation reached locally or through an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 user@pixelspace-host
```

For LAN or public access, terminate TLS in front of Pixelspace and set the
browser-facing HTTPS origin. Password login is rejected on a non-loopback bind
without that HTTPS origin:

```bash
./install.sh \
  --admin-email operator@example.com \
  --bind-address 0.0.0.0 \
  --auth-mode local \
  --public-url https://pixelspace.example.internal
```

To delegate sign-in to an existing identity provider instead, configure the
trusted-proxy header contract, TLS, and host firewall, then install with:

```bash
./install.sh \
  --bind-address 0.0.0.0 \
  --auth-mode proxy \
  --admin-email operator@example.com \
  --public-url https://pixelspace.example.internal
```

`--admin-email` configures the super-admin allowlist in either mode; proxy mode
does not create a local password. `AUTH_MODE=dev` remains available explicitly
for loopback-only development and has no login screen.

If the local administrator loses access, reset the password from the host. The
command revokes every existing browser session for that account:

```bash
scripts/pixelspace reset-admin-password --admin-email operator@example.com
```

`scripts/pixelspace doctor` rejects unauthenticated LAN exposure, local-password
LAN exposure without HTTPS, and invalid Compose/path configuration.

## DGX Spark

DGX Spark is an `arm64` host. Pixelspace's API image copies the Docker CLI from
Docker's official multi-architecture image, and the Compose image graph is
expected to provide both `linux/amd64` and `linux/arm64` variants.

Use the DGX profile for host qualification:

```bash
./install.sh \
  --profile dgx-spark \
  --admin-email operator@example.com \
  --model-url http://host.docker.internal:8000/v1 \
  --model-id nemotron-3.5-lightning
```

The profile verifies ARM64, `nvidia-ctk`, `nvidia-smi`, Docker, Compose, and the
same security checks as the core profile. Pixelspace itself does not request
the GPU; the checks establish that the target is the intended Spark host and
that its separately managed gateway can keep using the NVIDIA runtime.

A model listening on host `127.0.0.1` is not reachable from the bridged API
container. Configure that model service to listen on a Docker-reachable host
interface and restrict the interface with the host firewall. Then use
`host.docker.internal` in `CUSTOM_BASE_URL`; Compose supplies the Linux
`host-gateway` mapping. The operator rejects a `localhost` or `127.0.0.1` model
URL because accepting it would produce an install whose model fails only at the
first conversation.

The Spark's CPU and GPU share memory. The installer never starts a model,
changes an existing model container, or assumes unused GPU capacity. Model
installation can become a separate, explicitly selected provider pack after
the core appliance is proven.

## Build mode and image mode

`PIXELSPACE_DEPLOY_MODE=build` is the default until release images are
published. It builds API, web, and sandbox images on the target host.

`PIXELSPACE_DEPLOY_MODE=images` uses immutable image references stored in
`.env`. Images already loaded on the host are reused; only missing images are
pulled:

```text
PIXELSPACE_API_IMAGE=registry.example/pixelspace/api@sha256:DIGEST
PIXELSPACE_WEB_IMAGE=registry.example/pixelspace/web@sha256:DIGEST
SANDBOX_IMAGE=registry.example/pixelspace/sandbox@sha256:DIGEST
```

Release automation must publish one manifest containing `linux/amd64` and
`linux/arm64` for each image. The operator rejects mutable image-mode tags.
RustFS is pinned to a verified multi-architecture manifest instead of a
floating `latest` tag.

## Operate

```bash
scripts/pixelspace doctor
scripts/pixelspace status
scripts/pixelspace logs
scripts/pixelspace backup
scripts/pixelspace upgrade
scripts/pixelspace uninstall
```

`backup` briefly stops the API, active workspace sandboxes, and object store so
SQLite, workspace files, and RustFS objects describe one point in time. The
services and sandboxes that were running are restarted before the final archive
compression. The archive includes:

- SQLite and other API data
- workspace directories
- RustFS object data
- the MCP package cache
- encrypted-data secrets and deployment metadata

Every archive and checksum sidecar is private to the operator account. The
checksum remains valid if both files are moved or renamed together. Restore
verifies the checksum when present, rejects archive entries or links that escape
the restore root, and creates a safety backup of the current state before
replacing it:

```bash
scripts/pixelspace restore ~/pixelspace-backups/pixelspace-TIMESTAMP.tar.gz --yes
```

Restore keeps the destination host's paths and exposure settings while
restoring the secrets required to decrypt stored connector credentials and read
the object store. The previous configuration is copied beside `.env` before
secret merging. If a cutover step fails, the operator automatically attempts to
restore the safety backup and reports its path for manual recovery.

`upgrade` re-runs `doctor`, prepares the configured sandbox helper, and creates
a backup before pulling/building and recreating the stack. In build mode, update
the checkout to the intended release before running it. In image mode, update
the digest-pinned image references in `.env`.

`uninstall` stops services but preserves configuration and data. Permanent data
removal requires both flags:

```bash
scripts/pixelspace uninstall --purge --yes
```

## Offline installations

The operator can run in image mode after an administrator loads an image
bundle with `docker load`. A formal air-gapped release should contain the
versioned Compose file, the operator, all three digest-addressed Pixelspace
image archives, the pinned RustFS image, checksums, and a software/license manifest. The repository
does not yet declare a distribution license, so external redistribution must
wait for that product/legal decision even though internal on-prem installation
works.
