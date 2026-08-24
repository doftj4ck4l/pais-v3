# Nextplus Sandbox SDK integration handover

## Purpose

This handover is for the developer integrating the TypeScript [Pi Agent Harness](https://github.com/earendil-works/pi) with the Nextplus Sandbox service described by [ADR 0003](adr/0003-provide-a-harness-compatible-kubernetes-sandbox-api.md).

Sandbox workloads run on the `k8s01` node with `kubernetes.io/arch=amd64` and the `gvisor` RuntimeClass.

The TypeScript SDK follows the beta `SandboxClient` and `SandboxSession` interfaces exported by `@openai/agents-core/sandbox`. It implements only the command, lifecycle, and basic filesystem primitives needed by the Pi integration. It does not emulate Modal's private API.

## Current implementation status

The repository currently provides:

- `service/sandbox-api`: the authenticated northbound API and command/file gateway;
- `service/sandbox-controller`: the Kubebuilder lifecycle controller and Kubernetes API types;
- `sdk/typescript`: the `@mycip/sandbox` source, unit tests, and package build;
- `manifest/sandbox-api.yaml`, `manifest/sandbox-controller.yaml`, and `manifest/nfs-csi.yaml`: the deployed K3s resources;
- NFS-backed `/workspace`, gVisor/amd64 placement, reconnect behavior, and explicit unsupported errors.

Machine-readable package, class, environment-variable, backend, and audience
identifiers shown below are the current compatibility contract. Keep those
identifiers unchanged while using “Nextplus Sandbox” for the product name.

The Pi `ExecutionEnv` adapter and coding-agent extension intentionally remain handover work because they live at Pi's tool/session boundary. Cilium Gateway external ingress remains blocked, so a temporary conventional host Envoy now terminates the private test CA certificate on `10.0.151.12:443` and forwards to the API ClusterIP. The complete authenticated black-box contract passed from the Proxmox `vmbr0` client through this path. The URL is ready for test integration through that workaround; it is not evidence that Cilium Gateway is fixed. Do not replace it with a direct NodePort or Kubernetes credentials in Pi.

The TypeScript package targets Node.js 22.19 or newer, matching current Pi. It must not require a compiler or native extension at install time.

## Version pinning

OpenAI's TypeScript Sandbox Agent API is beta and pre-1.0. Pin the exact tested minor range in `@mycip/sandbox` and in the Harness lockfile. At the time of this decision, the inspected SDK is `@openai/agents-core` 0.17.x; do not assume a later minor remains compatible.

```json
{
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.84.x",
    "@earendil-works/pi-coding-agent": "<approved-version>",
    "@mycip/sandbox": "<approved-version>",
    "@openai/agents": "0.17.x",
    "@openai/agents-core": "0.17.x"
  }
}
```

Run structural and behavioral conformance tests before changing the OpenAI Agents or Pi minor version.

## Configuration

### Platform administration and developer access boundary

The Harness developer does not SSH to Kubernetes, receive a kubeconfig, or run
`kubectl`. Their integration boundary is HTTPS plus the CA certificate and
temporary bearer token described below.

The Sandbox API endpoint does not depend on Tailscale. Node-level Tailscale was
left in netfilter-off mode only as an optional administration path; it was also
stopped completely during Cilium diagnosis without changing the failure. A
future Tailscale Operator integration is separate work.

For platform operators, the non-Tailscale administration path starts the
project orb's narrow WireGuard client and reaches either Proxmox or the VM:

```sh
bash .agents/resume
until ping -c1 -W1 10.182.195.194 >/dev/null; do sleep 1; done

ssh -i ~/.ssh/proxmox_ed25519 \
  -o UserKnownHostsFile=~/.ssh/proxmox_known_hosts \
  root@10.182.195.194

ssh -i ~/.ssh/proxmox_ed25519 \
  -o UserKnownHostsFile=~/.ssh/k8s01_known_hosts \
  aiman@10.0.151.12
```

On `k8s01`, administrators use `sudo k3s kubectl`. The key authenticates SSH;
K3s's local admin kubeconfig authorizes cluster administration. Do not transfer
that key or kubeconfig to the Harness developer. If direct VM access is in
doubt, connect to Proxmox first and probe `10.0.151.12` over `vmbr0`. WireGuard
was intermittently unresponsive during setup; the recovery and evidence are in
[`cilium-k3s-setup-notes.md`](cilium-k3s-setup-notes.md).

### Harness runtime configuration

Provision configuration as service environment variables or mounted files, not command-line secrets:

```sh
export MYCIP_SANDBOX_URL='https://10.0.151.12'
export MYCIP_SANDBOX_TOKEN_FILE='/run/secrets/mycip-sandbox/token'
export NODE_EXTRA_CA_CERTS='/etc/ssl/mycip-sandbox-ca.pem'
```

- The test URL is the TLS-protected host Envoy on the `k8s01` VM's internal `vmbr0` address—not a Pod IP, ClusterIP, public endpoint, or unauthenticated NodePort. Cilium Gateway remains blocked behind this temporary implementation.
- During the temporary shared-key phase, the token file contains the static test bearer key and must be readable only by the Harness service. Replace it with a short-lived audience-bound token when remote identity is implemented.
- Prefer a `tokenProvider: () => Promise<string>` callback when the identity system can refresh credentials.
- Mount the platform-provided test CA certificate and set `NODE_EXTRA_CA_CERTS` before Node.js starts. The current SDK does not consume `MYCIP_SANDBOX_CA_BUNDLE` itself.
- Do not disable TLS verification.
- Never log authorization headers, tokens, command environment values, stdin, stdout, stderr, or transferred file content by default.

Pi does not receive Kubernetes credentials and does not invoke `kubectl`.

### Temporary shared-key authentication for the test system

Until remote OIDC or mTLS is available, the test deployment may authenticate the
Harness with one static bearer token stored in the `sandbox-api-shared-auth`
Kubernetes Secret. This is a temporary test-only path; Kubernetes ServiceAccount
TokenReview remains enabled in parallel.

Create or rotate the key without writing it to a manifest or shell history:

```sh
umask 077
openssl rand -base64 48 | tr -d '\n' > /tmp/mycip-sandbox-shared.token
sudo k3s kubectl -n sandbox-system create secret generic sandbox-api-shared-auth \
  --from-file=token=/tmp/mycip-sandbox-shared.token \
  --dry-run=client -o yaml | sudo k3s kubectl apply -f -
sudo k3s kubectl -n sandbox-system rollout restart deployment/sandbox-api
sudo k3s kubectl -n sandbox-system rollout status deployment/sandbox-api
```

Transfer the mode-600 token file to the Harness secret store through an approved
secret channel, set `MYCIP_SANDBOX_TOKEN_FILE` to its mounted path, then delete
all transfer copies. Never paste the key into Git, a manifest, a command-line
argument, logs, or ordinary handover notes. Rotation replaces the Secret,
restarts `sandbox-api`, updates the Harness secret, and invalidates the old key.

The current platform-side transfer copies on `k8s01` are:

```text
/home/aiman/.config/mycip/sandbox-harness.token
/home/aiman/.config/mycip/sandbox-gateway-ca.crt
```

The first file is secret; the second is the public test CA. Their contents are
not included in this handover. The CA was rotated during qualification to add
the X.509 key usages required by strict clients, so discard any earlier CA copy.
The external host Envoy path is qualified, so these files may now be transferred
through the approved secret channel. Do not paste their contents into chat,
source control, command arguments, or ordinary handover notes.

### 1Password credential handoff

The platform owner provides a recipient-restricted, expiring 1Password share
for the `sandbox-api credentials` item. Treat the share URL itself as a secret:
do not forward it or place it in source control, tickets, build logs, or this
handover. The item contains these attachments:

```text
token
mycip-sandbox-ca.pem
```

The `token` attachment is the temporary shared bearer credential. Materialize
it as `/run/secrets/mycip-sandbox/token`, readable only by the Harness process
(mode 0600 for a host file). Materialize `mycip-sandbox-ca.pem` read-only as
`/etc/ssl/mycip-sandbox-ca.pem`. Prefer the runtime's secret-file and read-only
configuration-mount facilities instead of copying either file into an image.
Delete local download or staging copies after provisioning the runtime.

Set the environment variables shown in the Harness runtime configuration
section. In particular, set `NODE_EXTRA_CA_CERTS` before Node.js starts and pass
only the token file path through `MYCIP_SANDBOX_TOKEN_FILE`; do not place the
token value itself in an environment variable. Verify network reachability and
the CA without sending the bearer token:

```sh
curl --fail \
  --cacert /etc/ssl/mycip-sandbox-ca.pem \
  https://10.0.151.12/healthz
```

The expected response is `{"status":"ok"}`. Then run the authenticated SDK or
black-box contract through its token-file configuration. Never add the token to
a curl command line, disable certificate verification, or log authorization
headers. The platform owner should revoke the 1Password share after receipt and
rotate the shared key if the link or downloaded token may have reached an
unintended recipient.

The shared key maps every holder to the single stable test subject
`shared:test-harness`; it therefore provides no per-user attribution or tenant
separation. Remove the Secret and the `SANDBOX_SHARED_TOKEN` deployment setting
when OIDC or mTLS is ready.

## Workload log API

Retrieve retained process output for a Sandbox with:

```text
GET /v1/sandboxes/{sandbox_id}/logs
```

The bearer identity must own the Sandbox. Knowing a Sandbox ID is not sufficient,
and the API performs the ownership check before querying the log store. The
endpoint returns workload process output written through the container's stdout
and stderr streams. Output returned directly by `POST .../execute` is not a
workload log because Kubernetes exec output does not enter the container runtime
log stream.

Optional query parameters are:

| Parameter | Meaning |
| --- | --- |
| `since` | Inclusive range start as an RFC 3339 timestamp with a timezone; defaults to Sandbox creation. |
| `until` | Range end as an RFC 3339 timestamp with a timezone; defaults to the request time. |
| `limit` | Maximum entries, from 1 through the server limit; defaults to 1,000 and is currently capped at 10,000. |
| `stream` | `stdout` or `stderr`; omit it to return both streams. |

For example, this request obtains at most 500 stderr records. Supplying curl's
configuration on standard input keeps the token out of the process argument
list:

```sh
SANDBOX_ID='sb-0123456789abcdef01234567'

curl --silent --show-error --fail-with-body \
  --config - \
  --cacert /etc/ssl/mycip-sandbox-ca.pem \
  --get \
  --data-urlencode 'since=2026-08-21T09:00:00Z' \
  --data-urlencode 'limit=500' \
  --data-urlencode 'stream=stderr' \
  "${MYCIP_SANDBOX_URL}/v1/sandboxes/${SANDBOX_ID}/logs" <<EOF
header = "Authorization: Bearer $(cat "${MYCIP_SANDBOX_TOKEN_FILE}")"
EOF
```

A successful response is:

```json
{
  "sandbox_id": "sb-0123456789abcdef01234567",
  "entries": [
    {
      "timestamp": "2026-08-21T09:15:04.123456789Z",
      "stream": "stderr",
      "message": "retrying connection",
      "pod_uid": "527c33a7-e49b-4e8a-9989-73d788d5fd24"
    }
  ],
  "truncated": false,
  "retention_seconds": 604800
}
```

Entries are ordered oldest first. One container-runtime record is one entry, and
duplicate entries are possible because collection is at least once. A successful
query with no retained records returns `200` and an empty `entries` array. The
current retention is seven days; an empty response for an older interval does
not prove that the workload emitted nothing. If `truncated` is true, request a
narrower time range because this bulk endpoint has no completeness-preserving
pagination. Streaming follow mode is not implemented yet.

Invalid timestamps, ranges, filters, or limits return an argument error. Missing
or rejected credentials return `401`, a non-owner receives `403`, and a missing
Sandbox returns `404`. A log-store timeout or failure returns `503` with code
`LOGS_UNAVAILABLE`; backend response content and workload messages are not copied
into the error. See [ADR 0008](adr/0008-provide-sandbox-workload-logs-through-the-api.md)
for the collection, storage, and data-protection design.

## OpenAI Agents interface boundary

The public TypeScript implementation imports the official interfaces rather than copying them:

```ts
import type {
  ExecCommandArgs,
  SandboxClient,
  SandboxExecResult,
  SandboxSession,
  SandboxSessionState,
} from "@openai/agents-core/sandbox";
```

`MycipSandboxClient` implements:

- `backendId = "mycip-kubernetes"`;
- `create(...)`;
- `delete(state)`;
- `serializeSessionState(state)`;
- `deserializeSessionState(payload)`;
- `resume(state)`.

`MycipSandboxSession` implements:

- `state` with the required trusted OpenAI `manifest`, an opaque Sandbox ID, and ownership flag;
- `running()`;
- `exec(args)` returning `SandboxExecResult`;
- `execCommand(args)` returning the OpenAI Agents formatted command string;
- `readFile(args)`;
- `listDir(args)`;
- `pathExists(path)` and `directoryExists(path)`;
- idempotent `close()`.

The concrete session also exposes a provider extension for the common basic filesystem primitives absent from the OpenAI interface:

```ts
interface MycipFilesystem {
  stat(path: string, options?: { signal?: AbortSignal }): Promise<FileInfo>;
  readBytes(
    path: string,
    options?: { maxBytes?: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  writeBytes(
    path: string,
    content: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  list(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<DirectoryEntry[]>;
  createDirectory(
    path: string,
    options?: { recursive?: boolean; signal?: AbortSignal },
  ): Promise<void>;
  remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; signal?: AbortSignal },
  ): Promise<void>;
}

interface MycipSandboxSession extends SandboxSession<MycipSandboxState> {
  readonly files: MycipFilesystem;
}
```

Pi's shell contract also needs timeout, environment, abort, and argv-safe execution that the OpenAI `ExecCommandArgs` type does not carry. Use the concrete provider extension:

```ts
const result = await session.execute({
  argv: ["git", "status", "--short"],
  cwd: "/workspace",
  env: { CI: "1" },
  timeoutSeconds: 30,
  maxOutputBytes: 1_000_000,
  signal: abortSignal,
});

// result: stdout, stderr, exitCode, timedOut, per-stream truncation,
// and wallTimeSeconds
```

Prefer `argv` whenever Pi already has structured arguments. Use `command` only for an intentional shell expression. Environment and paths are serialized fields, not interpolated into shell source.

Use OpenAI's method names and result/error semantics whenever its interface defines an operation. Keep the provider extension small; do not introduce Modal Apps, Images, Secrets, selectors, or IDs.

### Initial unsupported OpenAI capabilities

Do not advertise optional methods that are not implemented:

- `writeStdin` and PTY continuation;
- `viewImage`;
- `createEditor` and the default filesystem patch capability;
- workspace snapshots or archive persistence;
- manifests beyond the supported basic workspace initialization;
- mounts and caller-selected volumes;
- exposed ports;
- dynamic users or `runAs`.

Because the OpenAI interfaces feature-detect optional methods, omission is the correct behavior. Direct provider calls for recognized unsupported features raise a typed unsupported-feature error containing `code`, `feature`, and `requestId`.

An OpenAI `SandboxAgent` must initially opt into shell only; its default capability set expects editor and image methods that the MVP does not provide:

```ts
import { run } from "@openai/agents";
import { SandboxAgent, shell } from "@openai/agents/sandbox";
import { MycipSandboxClient } from "@mycip/sandbox/openai-agents";

const client = MycipSandboxClient.fromEnv();
const agent = new SandboxAgent({
  name: "nextplus-sandbox-agent",
  capabilities: [shell()],
});

const result = await run(agent, "Run git status and summarize it.", {
  sandbox: { client },
});
```

## Direct SDK usage

The concrete API keeps lifecycle ownership explicit:

```ts
import { MycipSandboxClient } from "@mycip/sandbox";

const client = MycipSandboxClient.fromEnv();
if (!client.create) throw new Error("create capability missing");
const session = await client.create({
  options: {
    timeoutSeconds: 3600,
    cpu: 1,
    memoryMiB: 2048,
    workspaceMiB: 4096,
    tags: { owner: "pi", thread: "thread-123" },
  },
});

try {
  if (!session.exec) throw new Error("exec capability missing");
  const result = await session.exec({
    cmd: "git status --short",
    workdir: "/workspace",
    shell: "/bin/bash",
    maxOutputTokens: 16_000,
  });

  console.log(result.stdout, result.stderr, result.exitCode);

  await session.files.writeBytes(
    "/workspace/pi.txt",
    new TextEncoder().encode("hello from Pi\n"),
  );
  const content = await session.files.readBytes("/workspace/pi.txt");
  console.log(new TextDecoder().decode(content));
} finally {
  // This terminates only a session created and owned by this client.
  await session.close?.();
  await client.close();
}
```

The platform chooses the approved coding image. The current server rejects caller-selected images other than its configured allowlisted image; Pi should normally omit `image`.

## Lifecycle and reconnect

Choose one ownership mode explicitly:

| Mode | Creation | Harness shutdown | Later run |
| --- | --- | --- | --- |
| Owned run | client creates | `close()` terminates | create a new Sandbox |
| Attached run | another owner created | `close()` detaches only | resume the same state |
| Persistent Pi session | first run creates and stores state | detach only | deserialize and resume |

Persist serialized provider state, not a Pod name. The opaque Sandbox ID is bound server-side to the trusted namespace, CR UID, controller-published active Pod, and workspace PVC. `sandbox-api` does not create lifecycle resources; the controller continuously converges the CR, PVC, Pod, and status even while the API is restarting.

If resume returns `SANDBOX_UNAVAILABLE`, preserve the state and warn that the NFS workspace may contain the only copy of uncommitted work. Never create an empty replacement implicitly. Expired state returns `SANDBOX_EXPIRED`; replacement remains an explicit product action.

Sandbox conversation state and Sandbox workspace state are separate. Pi's session JSONL remains owned by Pi; deleting a Sandbox must not delete Pi's conversation history.

## Pi integration strategy

### Preferred future adapter: `ExecutionEnv`

Pi's newer environment seam combines shell and filesystem operations. Implement `MycipExecutionEnv` against one `MycipSandboxSession` so every tool sees the same `/workspace`:

```ts
class MycipExecutionEnv implements ExecutionEnv {
  constructor(
    readonly session: MycipSandboxSession,
    readonly cwd = "/workspace",
  ) {}

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<
    Result<
      { stdout: string; stderr: string; exitCode: number },
      ExecutionError
    >
  > {
    if (options?.inheritEnv === false) {
      return err(
        new ExecutionError(
          "shell_unavailable",
          "The MVP always inherits the configured Sandbox environment",
        ),
      );
    }
    const result = await this.session.execute({
      command,
      cwd: options?.cwd ?? this.cwd,
      env: options?.env,
      timeoutSeconds: options?.timeout
        ? options.timeout / 1000
        : undefined,
      signal: options?.abortSignal,
    });
    options?.onStdout?.(result.stdout);
    options?.onStderr?.(result.stderr);
    if (result.timedOut) {
      return err(new ExecutionError("timeout", "Remote command timed out"));
    }
    return ok({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
    });
  }

  async readTextFile(path: string, signal?: AbortSignal) {}
  async readTextLines(path: string, options?: ReadTextLinesOptions) {}
  async readBinaryFile(path: string, signal?: AbortSignal) {}
  async writeFile(
    path: string,
    content: string | Uint8Array,
    signal?: AbortSignal,
  ) {}
  async fileInfo(path: string, signal?: AbortSignal) {}
  async listDir(path: string, signal?: AbortSignal) {}
  // Implement the rest of Pi's FileSystem contract, or return its explicit
  // unsupported FileError for methods outside the MVP.
  async cleanup() {
    await this.session.close?.();
  }
}
```

Import `ExecutionEnv`, `ShellExecOptions`, `Result`, `ExecutionError`, `FileError`, `ok`, and `err` from `@earendil-works/pi-agent-core`; there is no public `./harness/types` subpath. The definitions above were inspected at Pi Agent Core 0.84.2. Pin the chosen release and compile against its exported interfaces rather than maintaining local duplicate types. Wrap callback exceptions as Pi `ExecutionError("callback_error", ...)`, and map an aborted request to `ExecutionError("aborted", ...)`; the abbreviated snippet leaves that surrounding `try`/`catch` out for readability.

Pi Agent Core 0.84.2 requires `absolutePath`, `joinPath`, text/line/binary reads, write, append, rename, file info, list, canonical path, existence, create/remove directory entries, temporary files/directories, and cleanup. Map them as follows:

| Pi operation | MVP mapping |
| --- | --- |
| `absolutePath`, `joinPath` | Pure POSIX path calculation relative to `/workspace`; no host filesystem call. |
| `readTextFile`, `readTextLines` | UTF-8 wrappers over `files.readBytes`; enforce line and byte bounds. |
| `readBinaryFile`, `writeFile` | `files.readBytes` and `files.writeBytes`. |
| `fileInfo`, `listDir`, `exists` | `files.stat`, `files.list`, and `pathExists`; map `dir` to Pi `directory` and preserve `mtimeMs`. |
| `createDir`, `remove` | `files.createDirectory` and `files.remove`. |
| `appendFile`, `renameFile`, `canonicalPath`, temporary files/directories | Return `FileError("not_supported", ...)` until dedicated remote primitives exist, or disable every Pi tool that requires them. |
| `cleanup` | Detach or terminate according to the session ownership policy. |

Every method resolves a Pi `Result`; expected filesystem and execution failures must not reject. Never satisfy a missing operation with local `node:fs`. Remote helper commands are acceptable only when invoked through `session.execute()` with structured argv and covered by adapter tests.

### MVP production adapter: coding-agent extension

Use a TypeScript Pi extension modeled on Pi's Gondolin remote-environment example. The extension must:

1. Create or resume one Nextplus Sandbox for the Pi session.
2. Persist the serialized Sandbox state through Pi's custom session entry mechanism.
3. Replace every active shell and filesystem tool with remote operations, including bash, read, write, edit, list, find, and grep where those tools are enabled.
4. Intercept `user_bash` so `!` and `!!` commands use the remote bash operations.
5. Disable any local tool for which no safe remote implementation exists.
6. Detach on normal Harness shutdown; terminate only through an explicit owned-run policy or user command.

Do not call Pi extension `exec()` for Sandbox commands—it executes on the Harness host. Do not fall back to Node `child_process` or `node:fs` when the remote service is unavailable.

Pi `onUpdate` callbacks may receive only a final output update in the basic completed-command MVP. Live partial output, PTY, and reconnectable process streams remain unsupported until the server implements the corresponding process capability.

Pi passes an `AbortSignal`, but the current command primitive cannot yet prove remote cancellation. On abort, stop waiting locally and report an aborted execution result; the remote process continues only until its mandatory server-side command deadline. Never claim it was killed unless the server confirms cancellation.

## Command semantics

- Send a command string and explicit workdir; the approved coding image provides `/bin/bash`.
- A non-zero process exit is a normal result, not an HTTP error.
- Return separate stdout and stderr plus combined formatted output for `execCommand`.
- Enforce finite server-side command deadlines.
- Report wall time, exit code, timeout, and truthful truncation.
- Do not treat a client disconnect as proof the process stopped.
- `pathExists() === false` means confirmed absence. Permission, transport, or I/O failure must throw a typed error instead of returning false.

## Error mapping

The SDK exposes provider errors and maps them to OpenAI/Pi errors at adapter boundaries:

| Server code | OpenAI Agents mapping | Pi mapping |
| --- | --- | --- |
| `UNSUPPORTED_FEATURE` | `SandboxUnsupportedFeatureError` | explicit unsupported `Result` error |
| `SANDBOX_UNAVAILABLE` | `SandboxProviderError`, retryable | execution/filesystem unavailable |
| `SANDBOX_EXPIRED` | lifecycle/provider error, not retryable | session expired |
| `EXEC_TIMEOUT` | `SandboxExecTimeoutError` | timeout execution error |
| `EXEC_TRANSPORT_ERROR` | `SandboxExecTransportError` | transport execution error |
| `INVALID_ARGUMENT` | `SandboxConfigurationError` | invalid path/argument |
| file-specific codes | provider/file error | matching Pi `FileErrorCode` |

Preserve safe `requestId`, feature, HTTP status, and retryability. Never classify authentication or authorization failure as retryable except for one explicit token refresh on an authentication failure.

Mutating retries reuse their original idempotency key. Do not retry unsafe requests without one.

## NFS workspace expectations

Every Sandbox mounts its own NFS CSI PVC at `/workspace`. The initial NFSv4.1 server is hosted on `k8s01`; future workers mount the same StorageClass over the private cluster network.

The Harness must treat NFS or mount failure as `SANDBOX_UNAVAILABLE`, not an empty repository. Requested PVC capacity is advisory unless the platform confirms server-side quota enforcement. The SDK must expose whether workspace quota is `enforced` or `advisory` in session capabilities so UI and policy do not misrepresent it.

Do not expose the NFS server to the Harness, pass NFS credentials, or mount NFS on the Harness host. Only trusted Kubernetes nodes and the CSI driver mount the export.

## Developer acceptance checklist

- [x] Pin and test `@openai/agents-core` 0.17.x in `@mycip/sandbox`.
- [x] Pass TypeScript provider unit tests and package build.
- [x] Pass the live black-box contract harness on `k8s01`.
- [x] Confirm the workload Pod uses `runtimeClassName: gvisor`, node architecture `amd64`, and the NFS PVC.
- [x] Verify timeout, non-zero exit, binary transfer, path rejection, reconnect, idempotency, authentication, and unsupported behavior in the live service.
- [ ] Pin the Pi package version in the consuming Harness.
- [ ] Verify TLS hostname and CA validation; no insecure bypass exists.
- [ ] Verify token refresh and credential redaction.
- [ ] Build and pass Pi `ExecutionEnv` conformance tests against the pinned Pi release.
- [ ] Persist provider state in a Pi session, restart Pi, resume, and verify the same `/workspace` contents.
- [ ] Simulate NFS and Pod unavailability and prove Pi never creates an empty replacement silently.
- [ ] Route bash, read, write, edit, list, find, grep, and `user_bash` remotely or disable unsupported tools.
- [ ] Prove no shell or filesystem tool invokes local `child_process` or `node:fs` for Sandbox work.
- [ ] Verify Pi abort mapping, output updates, oversized files, symlinks, and every enabled tool.
- [ ] Record SDK/server versions, endpoint, audience, image digest, StorageClass, and rollback owner without recording credentials.

## Reproducing the tests

Run the SDK checks from the repository:

```sh
cd sdk/typescript
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## Ownership boundary

The Pi developer owns the TypeScript adapter, Pi session-state binding, dependency pins, UI behavior for unavailable/expired sessions, and ensuring all active tools route remotely.

The platform owner owns `sandbox-api`, the TypeScript SDK release, TLS and identity, authorization, gVisor, the coding image, NFS server and CSI driver, quotas and disk safeguards, network policy, lifecycle cleanup, observability, and compatibility tests.

Neither owner may work around a missing feature by giving Pi Kubernetes credentials, exposing an unauthenticated NodePort, disabling TLS verification, mounting NFS on the Harness host, or falling back to local command execution.