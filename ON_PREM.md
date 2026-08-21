# Pixelspace on-prem installation

Pixelspace ships as a single-host Docker Compose appliance. A core installation
stays independent from model inference and points at an existing
OpenAI-compatible gateway. On a DGX Spark, an explicit model pack can instead
run the supported Nemotron vLLM service inside the same private Compose network.

The first supported host contract is:

- Linux on `amd64` or `arm64`
- Docker Engine with Docker Compose v2
- a local filesystem for Pixelspace state (not NFS)
- outbound access to build/pull images and dependencies, unless images have
  already been loaded for an offline installation
- either an existing OpenAI-compatible model endpoint or the DGX Spark model
  pack

The installer does not add operating-system repositories, modify the firewall,
or install Docker with root privileges. Those are host-administration choices,
not application installation details.

## Install

If you do not yet know the model URL or model ID, follow
[Find the model URL and model ID](SETUP_MANUAL.md#3-find-the-model-url-and-model-id)
before running the installer.

From a release checkout:

```bash
./install.sh \
  --admin-email operator@example.com \
  --model-url https://gateway.example.internal/v1 \
  --model-id my-model
```

The default `local` authentication mode generates a strong random password for
the first administrator and prints it once after the account is created. Save
it immediately and treat captured installer output as sensitive. The password
is Argon2id-hashed in Pixelspace's SQLite database and is never written to an
environment file or passed as a process argument. To choose the password, use a
protected file instead:

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
data. At the end, the installer prints the `Dashboard URL` to give the
operator a copy-ready browser address. The default loopback URL is only
reachable on the server itself; use the SSH tunnel below or configure a
browser-facing `--public-url` for remote access.

The default security posture is intentionally local:

```text
WEB_BIND_ADDRESS=127.0.0.1
AUTH_MODE=local
```

For quick testing from a trusted private network, you can explicitly expose
the detected RFC1918 address over HTTP:

```bash
./install.sh --expose --admin-email operator@example.com
```

This prints a private-IP dashboard URL and persists the opt-in. `--expose` is
testing-only: password login travels over plain HTTP, so use HTTPS for any
shared, production, or untrusted network.

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
  --model-pack nemotron-3.5-lightning
```

The profile verifies ARM64, `nvidia-ctk`, `nvidia-smi`, Docker, Compose, and the
same security checks as the core profile. The model pack starts the pinned vLLM
runtime with NVIDIA Nemotron 3.5 Lightning and DSpark speculative decoding. It
uses 85% of GPU memory, serves a 131,072-token context, and reuses the host's
`~/.cache/huggingface` model cache. First startup can take several minutes or
download model weights when they are not already cached. Compiled kernels and
autotuning results persist in the `vllm-cache` Docker volume to make later
container recreation faster.

The bundled model listens only on the private Compose network. Pixelspace uses
`http://model:8000/v1`; Docker publishes no model port to the host or LAN. The
pack is explicit so installing Pixelspace never claims a GPU or downloads a
large model unexpectedly. External gateways remain supported by omitting
`--model-pack` and supplying `--model-url` plus `--model-id`.

For an external model running directly on the Spark host, a service listening
on `127.0.0.1` is not reachable from the bridged API container. Configure that
service to listen on a Docker-reachable host interface and restrict the
interface with the host firewall. Then use `host.docker.internal` in
`CUSTOM_BASE_URL`; Compose supplies the Linux `host-gateway` mapping. The
operator rejects a `localhost` or `127.0.0.1` model URL because accepting it
would produce an install whose model fails only at the first conversation.

The Spark's CPU and GPU share memory. Do not enable the pack while another model
runtime owns the GPU. Removing the Compose model container does not delete the
Hugging Face cache, so the pack can be recreated without downloading the weights
again.

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
PIXELSPACE_MODEL_IMAGE=vllm/vllm-openai@sha256:DIGEST  # DGX pack only
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

The Hugging Face model cache is not included because it is large reproducible
data. Preserve it separately for fully offline recovery.

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

Every release carries a version (SemVer, in the repo-root `VERSION` file, baked
into the API image). `status` and `doctor` print the installed version and note
when the checkout provides a newer one; `upgrade` prints the `X -> Y` transition
and **refuses a downgrade** (check out the installed release or newer first).
The running app reports its own version at `GET /api/meta`.

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
