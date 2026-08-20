# Pixelspace setup manual

This is the practical, step-by-step guide for installing and operating
Pixelspace on one Linux server, including an NVIDIA DGX Spark. For the detailed
deployment contract and security rationale, see [ON_PREM.md](ON_PREM.md).

## 1. What you need

Prepare the following before starting:

- A Linux server using `amd64` or `arm64`
- Docker Engine and Docker Compose v2
- Git and SSH access to the Pixelspace repository
- A local disk for Pixelspace data (do not use NFS)
- An existing OpenAI-compatible model endpoint ending in `/v1`, unless using
  the bundled DGX Spark model pack
- A DNS name and HTTPS reverse proxy if users will access Pixelspace over a LAN
  or from a mobile device

Verify Docker:

```bash
docker --version
docker compose version
docker info
```

The installer does not install Docker, change the host firewall, or configure
TLS. Those remain host-administrator responsibilities.

## 2. Clone the repository

Run this on the server that will host Pixelspace:

```bash
git clone ssh://git@10.45.154.236/nextplus/pixelspacev3.git pixelspace
cd pixelspace
```

Use a release tag or an approved branch for production installations. Pulling
the latest development branch directly into production is not recommended.

## 3. Find the model URL and model ID

For a normal installation, Pixelspace connects to a model gateway that is
already running and implements the OpenAI-compatible API. Before running the
installer, discover these two values. DGX Spark users who select the bundled
model pack can skip to step 4 because the installer supplies both values.

| Installer option | Meaning | Example |
| --- | --- | --- |
| `--model-url` | Base address of the model API, including `/v1` | `http://10.0.151.4:9504/v1` |
| `--model-id` | Exact model name returned by `/v1/models` | `qwen3.8-27b-uncensored` |

### Check whether a model service is listening

If the model should run on the same server, inspect its listening ports and
containers:

```bash
sudo ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
```

Look for the model service and note its port. Common ports include `8000`,
`9504`, and `11434`, but the actual service can use any port. If the model is on
another machine, ask its operator for the server address, port, and API key if
one is required.

### Ask the gateway which models it serves

First test from the host. Replace the address and port with the values you
found:

```bash
curl --fail --show-error http://127.0.0.1:9504/v1/models
```

For a model on another server:

```bash
curl --fail --show-error http://MODEL_SERVER_IP:9504/v1/models
```

A successful OpenAI-compatible response contains a `data` list. Copy the
value of `data[].id`; that exact value is the Pixelspace `--model-id`:

```json
{
  "data": [
    {
      "id": "qwen3.8-27b-uncensored",
      "object": "model"
    }
  ]
}
```

If `jq` is installed, print only the available model IDs:

```bash
curl --silent --fail http://MODEL_SERVER_IP:9504/v1/models |
  jq -r '.data[].id'
```

An HTTP `401` or `403` usually means the gateway requires an API key:

```bash
read -r -s -p 'Model API key: ' pixelspace_model_api_key
printf '\n'
curl --fail --show-error \
  --header "Authorization: Bearer $pixelspace_model_api_key" \
  http://MODEL_SERVER_IP:9504/v1/models
unset pixelspace_model_api_key
```

Do not put an API key directly in the command history. Pixelspace reads a
gateway key from `CUSTOM_API_KEY` in the private generated `.env` file. The
installer intentionally does not accept the key as a command-line option. If a
key is required, run the installer once to generate `.env`, edit that file and
set `CUSTOM_API_KEY`, keep it mode `600`, then re-run the same installer
command. Installation is idempotent and the existing administrator password and
data are preserved.

### Test one real answer

Listing a model proves that the gateway is reachable, but not that inference
works. Send a small chat request using the ID returned above:

```bash
curl --fail --show-error \
  --header 'Content-Type: application/json' \
  --data '{"model":"qwen3.8-27b-uncensored","messages":[{"role":"user","content":"Reply with MODEL_OK"}],"max_tokens":32}' \
  http://MODEL_SERVER_IP:9504/v1/chat/completions
```

The response should contain an assistant message. If it returns “model not
found,” copy the ID from `/v1/models` exactly, including capitalization and
punctuation.

### Choose the URL Pixelspace should use

- Model on another machine: use its reachable address directly, such as
  `http://10.0.151.4:9504/v1`.
- Model on the same Docker host: use
  `http://host.docker.internal:PORT/v1` in the Pixelspace installer.
- Hosted gateway: use its HTTPS API base URL.

For a same-host model, `ss` must show it listening on a Docker-reachable
interface such as `0.0.0.0:9504`, not only `127.0.0.1:9504`. Protect that port
with the host firewall.

You can optionally test the same route from a temporary Docker container before
installing Pixelspace:

```bash
docker run --rm \
  --add-host host.docker.internal:host-gateway \
  curlimages/curl:8.12.1 \
  --fail --show-error \
  http://host.docker.internal:9504/v1/models
```

If the model is remote, replace `host.docker.internal` with its server address.
This command may pull the small curl image the first time.

### Worked example

The development-network gateway used while writing this manual responds at:

```bash
curl --fail --show-error http://10.0.151.4:9504/v1/models
```

It currently reports:

```text
model URL: http://10.0.151.4:9504/v1
model ID:  qwen3.8-27b-uncensored
context:   8192 tokens
```

Therefore, its installer arguments are:

```bash
--model-url http://10.0.151.4:9504/v1 \
--model-id qwen3.8-27b-uncensored
```

Use these values only when the target Pixelspace server can reach that internal
address. Otherwise, repeat the checks above for the gateway available to that
server.

## 4. Choose how users will connect

### Option A: private access through an SSH tunnel

This is the simplest secure setup. Pixelspace stays bound to the server's
loopback interface and does not require a reverse proxy.

Install on the server:

```bash
./install.sh \
  --admin-email operator@example.com \
  --model-url http://10.0.151.4:9504/v1 \
  --model-id qwen3.8-27b-uncensored
```

Those model values come from the `/v1/models` check in step 3. Replace them when
installing on a network that cannot reach this gateway.

From your computer, open a tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 user@pixelspace-server
```

Then open <http://localhost:8080> in your browser.

### Option B: LAN or mobile access

Password authentication on a non-loopback address requires an HTTPS public
URL. Configure a TLS reverse proxy such as Caddy, Nginx, or Traefik, and then
install with the browser-facing origin:

```bash
./install.sh \
  --bind-address 0.0.0.0 \
  --port 8080 \
  --auth-mode local \
  --public-url https://pixelspace.example.internal \
  --admin-email operator@example.com \
  --model-url http://10.0.151.4:9504/v1 \
  --model-id qwen3.8-27b-uncensored
```

The reverse proxy should forward the HTTPS site to `http://127.0.0.1:8080` or
another firewall-restricted interface. Do not expose the plain HTTP port
directly to an untrusted network.

## 5. Create the first administrator

Local password authentication is the default. During the first installation,
the installer asks for the administrator password twice. Use at least 12
characters.

The password is stored only as an Argon2id hash. It is not written to `.env`,
shown in logs, or passed as a command-line argument.

For unattended installation, place the password in a protected file:

```bash
install -m 600 /dev/null /secure/pixelspace-admin-password
printf 'replace-with-a-long-password\n' > /secure/pixelspace-admin-password

./install.sh \
  --admin-email operator@example.com \
  --admin-password-file /secure/pixelspace-admin-password \
  --model-url http://10.0.151.4:9504/v1 \
  --model-id qwen3.8-27b-uncensored
```

Delete or securely archive the password file after the installation. Re-running
the installer preserves the existing administrator and does not silently reset
the password.

## 6. DGX Spark installation

The DGX Spark profile checks the ARM64 architecture, NVIDIA Container Toolkit,
GPU visibility, Docker, Compose, and the standard Pixelspace security rules.
To let Pixelspace manage the known-good Nemotron service, run:

```bash
./install.sh \
  --profile dgx-spark \
  --admin-email operator@example.com \
  --model-pack nemotron-3.5-lightning
```

This starts a pinned vLLM image with NVIDIA Nemotron 3.5 Lightning, DSpark
speculative decoding, a 131,072-token context, and an 85% GPU-memory limit. It
reuses `~/.cache/huggingface`; an existing download is not discarded. If the
weights are absent, the first start downloads them and can take a while. vLLM's
compiled kernels and tuning results persist separately in the `vllm-cache`
Docker volume, so later container recreation is faster.

The bundled model has no published host port. Only the Pixelspace API can reach
it at `http://model:8000/v1`. Use `scripts/pixelspace logs model` to watch model
startup and `scripts/pixelspace status` to check its health.

Do not enable the model pack while another inference runtime owns the GPU. The
pack is optional and explicit because its image is large and starting it changes
GPU resource usage.

When using a separately managed model instead, omit `--model-pack` and pass the
external `--model-url` and `--model-id` found in step 3.

A model bound only to the host's `127.0.0.1` is not reachable from the API
container. Bind the model service to a Docker-reachable host interface, protect
that interface with the firewall, and use `host.docker.internal` in the
Pixelspace model URL.

For mobile access to the DGX Spark, combine the DGX profile with the LAN/HTTPS
options from step 4:

```bash
./install.sh \
  --profile dgx-spark \
  --bind-address 0.0.0.0 \
  --public-url https://pixelspace.example.internal \
  --admin-email operator@example.com \
  --model-pack nemotron-3.5-lightning
```

## 7. Verify the installation

Run:

```bash
scripts/pixelspace doctor
scripts/pixelspace status
curl --fail http://127.0.0.1:8080/api/meta
```

A healthy installation has running API, web, and storage services, and the
`/api/meta` request returns JSON describing the configured models.

To follow service output:

```bash
scripts/pixelspace logs
```

After verification, open the configured URL and sign in with the administrator
email and password from step 5.

## 8. Authentication modes

| Mode | Intended use | Sign-in behavior |
| --- | --- | --- |
| `local` | Normal on-prem installation | Pixelspace email and password |
| `proxy` | Existing identity-aware reverse proxy | Trusts the configured identity header |
| `dev` | Local development only | No login screen; loopback only |

The addresses in `SUPER_ADMIN_EMAILS` are the only users allowed into the
super-admin panel. Creating a local password does not independently grant
super-admin access.

To reset a local administrator password, run this on the host:

```bash
scripts/pixelspace reset-admin-password --admin-email operator@example.com
```

The reset command revokes every existing browser session for that account.

## 9. Change the model later

Pixelspace expects an OpenAI-compatible endpoint and a model identifier:

```bash
./install.sh \
  --admin-email operator@example.com \
  --model-url https://gateway.example.internal/v1 \
  --model-id your-model-id
```

Important checks:

- The endpoint must include `/v1` when required by the gateway.
- The endpoint must be reachable from inside the API container.
- Do not use `localhost` for a model running on the Docker host.
- Keep model gateways off untrusted networks or require an API key.
- Run a short conversation after installation to verify real inference, not
  only the metadata health endpoint.

Repeat the discovery and inference checks from step 3 whenever the gateway or
model changes, then re-run the installer with the new values. Existing users,
workspaces, secrets, and application data are preserved.

To change a DGX from the bundled model pack to an external gateway, specify the
external pack explicitly together with the new values:

```bash
./install.sh \
  --profile dgx-spark \
  --model-pack external \
  --model-url https://gateway.example.internal/v1 \
  --model-id your-model-id \
  --admin-email operator@example.com
```

## 10. Routine operations

Run these commands from the Pixelspace repository directory:

```bash
scripts/pixelspace doctor   # validate host and configuration
scripts/pixelspace status   # show service status
scripts/pixelspace logs     # follow logs
scripts/pixelspace backup   # create a consistent backup
scripts/pixelspace upgrade  # back up, update, and verify
scripts/pixelspace uninstall
```

The generated root `.env` is private deployment configuration and should remain
mode `600`. Persistent data defaults to:

```text
$XDG_DATA_HOME/pixelspace
```

or, when `XDG_DATA_HOME` is unset:

```text
~/.local/share/pixelspace
```

## 11. Backup and restore

Create a backup:

```bash
scripts/pixelspace backup
```

Backups default to `~/pixelspace-backups`. Keep both the archive and its
checksum sidecar. A backup includes the application database, workspaces,
object data, MCP package cache, encryption secrets, and deployment metadata.

Restore a backup:

```bash
scripts/pixelspace restore \
  ~/pixelspace-backups/pixelspace-TIMESTAMP.tar.gz \
  --yes
```

Restore validates the checksum and payload manifest before replacing current
state, creates a safety backup, and attempts rollback if cutover fails.

## 12. Upgrade

In the default build mode, update the release checkout first:

```bash
git fetch --all --tags
git checkout YOUR_APPROVED_RELEASE
scripts/pixelspace upgrade
```

The upgrade command runs host checks, creates a backup, rebuilds or pulls the
configured images, recreates the services, and verifies the result.

If the host still has containers or named volumes from the former Compose
project name, `install` or `upgrade` migrates their data automatically. It
stops the old stack, copies each named volume to its `pixelspace_*` replacement,
starts and verifies Pixelspace, and removes the old resources only after the
health check passes. The existing `S3_BUCKET` value is preserved so previously
generated images remain available.

## 13. Uninstall

Stop and remove the application containers while keeping all data:

```bash
scripts/pixelspace uninstall
```

Permanently remove the application data only when you have verified a backup:

```bash
scripts/pixelspace uninstall --purge --yes
```

The purge operation is intentionally explicit and cannot be undone without a
backup.

## 14. Troubleshooting

### The site does not open

```bash
scripts/pixelspace status
scripts/pixelspace doctor
scripts/pixelspace logs
```

Confirm that the configured port is listening and that the host firewall or
reverse proxy permits access.

### Login is rejected

- Confirm the installation uses `AUTH_MODE=local`.
- Use the same normalized email address supplied during installation.
- Confirm the email is present in `SUPER_ADMIN_EMAILS` for admin access.
- Reset the password with `scripts/pixelspace reset-admin-password` if needed.
- Confirm the browser is using the exact HTTPS origin in `PUBLIC_URL`.

### Models appear unavailable or runs fail

- Call the model's `/v1/models` endpoint from the host.
- Check API logs with `scripts/pixelspace logs`.
- Confirm the model service is reachable from Docker, not only from the host.
- Verify the model identifier exactly matches the gateway's configured alias.
- Check the API key and gateway firewall rules.
- For the bundled DGX pack, run `scripts/pixelspace logs model` and confirm that
  no other runtime is already consuming the GPU.

### DGX checks fail

```bash
uname -m
nvidia-smi
nvidia-ctk --version
docker info
docker compose version
```

The expected architecture is `aarch64`. Pixelspace will not install missing
NVIDIA or Docker host components automatically.

### Check all operator options

```bash
scripts/pixelspace help
```

## 15. Security checklist

Before giving users access:

- Use HTTPS for all LAN or public access.
- Restrict the plain application port with the host firewall.
- Use a strong, unique administrator password.
- Keep `.env`, password files, backups, and checksum files private.
- Do not expose the Docker socket or model gateway publicly.
- Run `scripts/pixelspace doctor` after configuration changes.
- Create and test a backup before every upgrade.
- Keep the operating system, Docker, and reverse proxy patched.
