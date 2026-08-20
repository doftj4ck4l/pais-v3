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
- An existing OpenAI-compatible model endpoint ending in `/v1`
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

## 3. Choose how users will connect

### Option A: private access through an SSH tunnel

This is the simplest secure setup. Pixelspace stays bound to the server's
loopback interface and does not require a reverse proxy.

Install on the server:

```bash
./install.sh \
  --admin-email operator@example.com \
  --model-url http://host.docker.internal:8000/v1 \
  --model-id your-model-id
```

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
  --model-url http://host.docker.internal:8000/v1 \
  --model-id your-model-id
```

The reverse proxy should forward the HTTPS site to `http://127.0.0.1:8080` or
another firewall-restricted interface. Do not expose the plain HTTP port
directly to an untrusted network.

## 4. Create the first administrator

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
  --model-url http://host.docker.internal:8000/v1 \
  --model-id your-model-id
```

Delete or securely archive the password file after the installation. Re-running
the installer preserves the existing administrator and does not silently reset
the password.

## 5. DGX Spark installation

The DGX Spark profile checks the ARM64 architecture, NVIDIA Container Toolkit,
GPU visibility, Docker, Compose, and the standard Pixelspace security rules:

```bash
./install.sh \
  --profile dgx-spark \
  --admin-email operator@example.com \
  --model-url http://host.docker.internal:8000/v1 \
  --model-id nemotron-3.5-lightning
```

Pixelspace does not install or start a model. It connects to a separately
managed OpenAI-compatible model gateway.

A model bound only to the host's `127.0.0.1` is not reachable from the API
container. Bind the model service to a Docker-reachable host interface, protect
that interface with the firewall, and use `host.docker.internal` in the
Pixelspace model URL.

For mobile access to the DGX Spark, combine the DGX profile with the LAN/HTTPS
options from step 3:

```bash
./install.sh \
  --profile dgx-spark \
  --bind-address 0.0.0.0 \
  --public-url https://pixelspace.example.internal \
  --admin-email operator@example.com \
  --model-url http://host.docker.internal:8000/v1 \
  --model-id nemotron-3.5-lightning
```

## 6. Verify the installation

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
email and password from step 4.

## 7. Authentication modes

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

## 8. Model configuration

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

## 9. Routine operations

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

## 10. Backup and restore

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

## 11. Upgrade

In the default build mode, update the release checkout first:

```bash
git fetch --all --tags
git checkout YOUR_APPROVED_RELEASE
scripts/pixelspace upgrade
```

The upgrade command runs host checks, creates a backup, rebuilds or pulls the
configured images, recreates the services, and verifies the result.

## 12. Uninstall

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

## 13. Troubleshooting

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

## 14. Security checklist

Before giving users access:

- Use HTTPS for all LAN or public access.
- Restrict the plain application port with the host firewall.
- Use a strong, unique administrator password.
- Keep `.env`, password files, backups, and checksum files private.
- Do not expose the Docker socket or model gateway publicly.
- Run `scripts/pixelspace doctor` after configuration changes.
- Create and test a backup before every upgrade.
- Keep the operating system, Docker, and reverse proxy patched.
