import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "pixelspace");
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "pixelspace-installer-"));
  temporary.push(home);
  const bin = path.join(home, "bin");
  const volumeRoot = path.join(home, "volumes");
  const dockerLog = path.join(home, "docker.log");
  mkdirSync(bin);
  mkdirSync(volumeRoot);
  const docker = path.join(bin, "docker");
  writeFileSync(docker, `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${PIXELSPACE_TEST_DOCKER_LOG:-}" ]]; then
  printf '%q ' "$@" >> "$PIXELSPACE_TEST_DOCKER_LOG"
  printf '\\n' >> "$PIXELSPACE_TEST_DOCKER_LOG"
fi
command="\${1:-}"
[[ $# -eq 0 ]] || shift
case "$command" in
  info) exit 0 ;;
  pull)
    [[ -z "\${PIXELSPACE_TEST_IMAGE_STATE:-}" ]] || : > "$PIXELSPACE_TEST_IMAGE_STATE"
    exit 0
    ;;
  compose)
    arguments=" $* "
    if [[ "$arguments" == *"local-admin.ts status"* ]]; then
      if [[ "\${PIXELSPACE_TEST_ADMIN_EXISTS:-0}" == "1" ]]; then
        printf 'present\\n'
        exit 0
      fi
      printf 'missing\\n'
      exit 3
    fi
    if [[ "$arguments" == *" ps "* && "\${PIXELSPACE_TEST_COMPOSE_PS_FAIL:-0}" == "1" ]]; then
      exit 1
    fi
    if [[ "$arguments" == *" ps "* && "\${PIXELSPACE_TEST_RUNNING_SERVICES:-0}" == "1" ]]; then
      printf 'fake-container-id\\n'
    fi
    if [[ "$arguments" == *" start api "* && "\${PIXELSPACE_TEST_RESTART_FAIL:-}" == "api" ]]; then
      exit 1
    fi
    if [[ "$arguments" == *" start rustfs "* && "\${PIXELSPACE_TEST_RESTART_FAIL:-}" == "rustfs" ]]; then
      exit 1
    fi
    exit 0
    ;;
  ps)
    [[ "\${PIXELSPACE_TEST_SANDBOX_LIST_FAIL:-0}" != "1" ]]
    [[ -z "\${PIXELSPACE_TEST_SANDBOX_CONTAINER:-}" ]] || printf '%s\n' "$PIXELSPACE_TEST_SANDBOX_CONTAINER"
    ;;
  stop) exit 0 ;;
  start)
    [[ "\${PIXELSPACE_TEST_SANDBOX_RESTART_FAIL:-0}" != "1" ]]
    ;;
  image)
    [[ "\${1:-}" != "inspect" || "\${PIXELSPACE_TEST_MISSING_IMAGES:-0}" != "1" || -f "\${PIXELSPACE_TEST_IMAGE_STATE:-/nonexistent}" ]]
    ;;
  inspect)
    if [[ -n "\${PIXELSPACE_TEST_MODEL_STATE:-}" ]]; then
      printf '%s\n' "$PIXELSPACE_TEST_MODEL_STATE"
    elif [[ "\${PIXELSPACE_TEST_MODEL_HEALTHY:-0}" == "1" ]]; then
      printf 'running healthy\n'
    fi
    ;;
  volume)
    operation="\${1:-}"
    [[ $# -eq 0 ]] || shift
    case "$operation" in
      inspect)
        [[ "\${PIXELSPACE_TEST_VOLUME_INSPECT_FAIL:-0}" != "1" ]]
        [[ -d "$PIXELSPACE_TEST_VOLUME_ROOT/\${1:?}" ]]
        ;;
      create) mkdir -p "$PIXELSPACE_TEST_VOLUME_ROOT/\${1:?}"; printf '%s\\n' "$1" ;;
      rm)
        for volume in "$@"; do
          find "$PIXELSPACE_TEST_VOLUME_ROOT/$volume" -depth -delete 2>/dev/null || true
        done
        ;;
      ls)
        [[ "\${PIXELSPACE_TEST_VOLUME_LIST_FAIL:-0}" != "1" ]]
        for entry in "$PIXELSPACE_TEST_VOLUME_ROOT"/*; do
          [[ ! -d "$entry" ]] || basename "$entry"
        done
        ;;
      *) exit 0 ;;
    esac
    ;;
  run)
    source_path=""
    target_path=""
    backup_path=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --rm) shift ;;
        --network) shift 2 ;;
        --user) shift 2 ;;
        -v)
          mapping="\${2:?}"
          mount_source="\${mapping%%:*}"
          mount_tail="\${mapping#*:}"
          mount_target="\${mount_tail%%:*}"
          if [[ "$mount_source" == /* ]]; then
            resolved_source="$mount_source"
          else
            resolved_source="$PIXELSPACE_TEST_VOLUME_ROOT/$mount_source"
          fi
          case "$mount_target" in
            /source) source_path="$resolved_source" ;;
            /target) target_path="$resolved_source" ;;
            /backup) backup_path="$resolved_source" ;;
          esac
          shift 2
          ;;
        *) shift; break ;;
      esac
    done
    if [[ "\${1:-}" == "python3" ]]; then
      input=""
      for argument in "$@"; do
        [[ "$argument" != /backup/* ]] || input="\${argument#/backup/}"
      done
      if [[ -n "$target_path" ]]; then
        python3 -c "$3" "$backup_path/$input" "$target_path"
      else
        python3 -c "$3" "$backup_path/$input"
      fi
    elif [[ -n "$source_path" && -n "$target_path" ]]; then
      if [[ "$(basename "$target_path")" == "\${PIXELSPACE_TEST_COPY_FAIL_VOLUME:-}" ]]; then
        exit 1
      fi
      mkdir -p "$target_path"
      cp -a "$source_path"/. "$target_path"/
    elif [[ -n "$source_path" ]]; then
      output=""
      for argument in "$@"; do
        [[ "$argument" != /backup/* ]] || output="\${argument#/backup/}"
      done
      [[ -n "$output" ]]
      tar -C "$source_path" -cf "$backup_path/$output" .
    elif [[ -n "$target_path" ]]; then
      if [[ -n "\${PIXELSPACE_TEST_RESTORE_FAIL_ONCE:-}" && ! -f "$PIXELSPACE_TEST_RESTORE_FAIL_ONCE" ]]; then
        : > "$PIXELSPACE_TEST_RESTORE_FAIL_ONCE"
        exit 1
      fi
      case "$(basename "$target_path")" in
        pixelspace_rustfs-data) input=rustfs-data.tar ;;
        pixelspace_mcp-cache) input=mcp-cache.tar ;;
        *) exit 1 ;;
      esac
      find "$target_path" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      [[ -z "$backup_path" ]] || tar -C "$target_path" -xf "$backup_path/$input"
    fi
    ;;
  *) exit 0 ;;
esac
`);
  chmodSync(docker, 0o755);
  const curl = path.join(bin, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "\${PIXELSPACE_TEST_CURL_LOG:?}"
exit 0
`);
  chmodSync(curl, 0o755);
  for (const command of ["nvidia-ctk", "nvidia-smi"]) {
    const target = path.join(bin, command);
    writeFileSync(target, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(target, 0o755);
  }
  return {
    home,
    envFile: path.join(home, "pixelspace.env"),
    volumeRoot,
    dockerLog,
    curlLog: path.join(home, "curl.log"),
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      PIXELSPACE_ENV_FILE: path.join(home, "pixelspace.env"),
      PIXELSPACE_ROOT_OVERRIDE: root,
      PIXELSPACE_TEST_MODE: "1",
      PIXELSPACE_SKIP_HEALTHCHECK: "1",
      PIXELSPACE_UID_OVERRIDE: "1234",
      PIXELSPACE_GID_OVERRIDE: "1235",
      PIXELSPACE_DOCKER_GID_OVERRIDE: "1236",
      PIXELSPACE_AUTH_MODE: "dev",
      PIXELSPACE_TEST_DOCKER_LOG: dockerLog,
      PIXELSPACE_TEST_CURL_LOG: path.join(home, "curl.log"),
      PIXELSPACE_TEST_VOLUME_ROOT: volumeRoot,
      PIXELSPACE_TEST_IMAGE_STATE: path.join(home, "image-present"),
      XDG_RUNTIME_DIR: home,
    },
  };
}

function run(args: string[], env: Record<string, string | undefined>) {
  return Bun.spawnSync(["bash", script, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
}

function setEnvValue(file: string, key: string, value: string) {
  const quoted = JSON.stringify(value);
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => !line.startsWith(`${key}=`));
  lines.push(`${key}=${quoted}`, "");
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });
}

function createTar(source: string, archive: string, gzip = false) {
  const result = Bun.spawnSync(["tar", "-C", source, gzip ? "-czf" : "-cf", archive, "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

describe("Pixelspace on-prem operator", () => {
  test("generates a private, loopback-only configuration", () => {
    const fx = fixture();
    const result = run(["install", "--dry-run"], fx.env);
    expect(result.exitCode).toBe(0);
    expect(statSync(fx.envFile).mode & 0o777).toBe(0o600);
    const body = readFileSync(fx.envFile, "utf8");
    expect(body).toContain('WEB_BIND_ADDRESS="127.0.0.1"');
    expect(body).toContain('AUTH_MODE="dev"');
    expect(body).toContain('S3_BUCKET="pixelspace-media"');
    expect(body).toContain(`PIXELSPACE_DATA_ROOT="${fx.home}/.local/share/pixelspace/data"`);
    expect(body).toContain('HOST_UID="1234"');
    expect(body).toContain('DOCKER_GID="1236"');
    expect(body).not.toContain("CONNECTION_SECRET=\"\"");
    expect(result.stdout.toString()).toContain("docker compose");
    expect(result.stdout.toString()).toContain("-p pixelspace");
  });

  test("migrates legacy Compose volumes before starting the Pixelspace stack", () => {
    const fx = fixture();
    const legacyRustfs = path.join(fx.volumeRoot, "salurai_rustfs-data");
    const legacyMcp = path.join(fx.volumeRoot, "salurai_mcp-cache");
    const legacyVllm = path.join(fx.volumeRoot, "salurai_vllm-cache");
    mkdirSync(legacyRustfs);
    mkdirSync(legacyMcp);
    mkdirSync(legacyVllm);
    writeFileSync(path.join(legacyRustfs, "object.bin"), "kept object");
    writeFileSync(path.join(legacyMcp, "package.bin"), "kept package");
    writeFileSync(path.join(legacyVllm, "kernel.bin"), "kept kernel");

    const dryRun = run(["install", "--dry-run"], fx.env);
    expect(dryRun.exitCode).toBe(0);
    expect(readFileSync(fx.envFile, "utf8")).not.toContain("PIXELSPACE_RESOURCE_MIGRATION");
    expect(readFileSync(fx.envFile, "utf8")).toContain('S3_BUCKET="salur-media"');
    expect(() => statSync(path.join(fx.volumeRoot, "pixelspace_rustfs-data"))).toThrow();
    expect(readFileSync(path.join(legacyRustfs, "object.bin"), "utf8")).toBe("kept object");

    const result = run(["install"], fx.env);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(path.join(fx.volumeRoot, "pixelspace_rustfs-data", "object.bin"), "utf8"))
      .toBe("kept object");
    expect(readFileSync(path.join(fx.volumeRoot, "pixelspace_mcp-cache", "package.bin"), "utf8"))
      .toBe("kept package");
    expect(readFileSync(path.join(fx.volumeRoot, "pixelspace_vllm-cache", "kernel.bin"), "utf8"))
      .toBe("kept kernel");
    expect(() => statSync(legacyRustfs)).toThrow();
    expect(() => statSync(legacyMcp)).toThrow();
    expect(() => statSync(legacyVllm)).toThrow();
    expect(readFileSync(fx.envFile, "utf8")).toContain('PIXELSPACE_RESOURCE_MIGRATION="complete"');
    const log = readFileSync(fx.dockerLog, "utf8");
    expect(log).toContain("-p salurai");
    expect(log).toContain("-p pixelspace");
  });

  test("refuses an untracked legacy and Pixelspace volume collision", () => {
    const fx = fixture();
    const legacy = path.join(fx.volumeRoot, "salurai_rustfs-data");
    const current = path.join(fx.volumeRoot, "pixelspace_rustfs-data");
    mkdirSync(legacy);
    mkdirSync(current);
    writeFileSync(path.join(legacy, "object.bin"), "legacy");
    writeFileSync(path.join(current, "object.bin"), "current");

    const result = run(["install"], fx.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("refusing to overwrite either");
    expect(readFileSync(path.join(legacy, "object.bin"), "utf8")).toBe("legacy");
    expect(readFileSync(path.join(current, "object.bin"), "utf8")).toBe("current");
  });

  test("resumes after a later legacy volume copy fails", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const legacyRustfs = path.join(fx.volumeRoot, "salurai_rustfs-data");
    const legacyMcp = path.join(fx.volumeRoot, "salurai_mcp-cache");
    mkdirSync(legacyRustfs);
    mkdirSync(legacyMcp);
    writeFileSync(path.join(legacyRustfs, "object.bin"), "kept object");
    writeFileSync(path.join(legacyMcp, "package.bin"), "kept package");

    const interrupted = run(["install"], {
      ...fx.env,
      PIXELSPACE_TEST_COPY_FAIL_VOLUME: "pixelspace_mcp-cache",
    });

    expect(interrupted.exitCode).toBe(1);
    expect(readFileSync(fx.envFile, "utf8")).toContain(
      'PIXELSPACE_RESOURCE_MIGRATION="copying:rustfs"',
    );
    const currentRustfs = path.join(fx.volumeRoot, "pixelspace_rustfs-data");
    expect(readFileSync(path.join(currentRustfs, "object.bin"), "utf8")).toBe("kept object");
    expect(() => statSync(path.join(fx.volumeRoot, "pixelspace_mcp-cache"))).toThrow();
    writeFileSync(path.join(currentRustfs, "object.bin"), "completed copy stays intact");

    const resumed = run(["install"], fx.env);

    expect(resumed.exitCode).toBe(0);
    expect(readFileSync(path.join(currentRustfs, "object.bin"), "utf8"))
      .toBe("completed copy stays intact");
    expect(readFileSync(path.join(fx.volumeRoot, "pixelspace_mcp-cache", "package.bin"), "utf8"))
      .toBe("kept package");
    expect(readFileSync(fx.envFile, "utf8")).toContain('PIXELSPACE_RESOURCE_MIGRATION="complete"');
  });

  test("resumes a copied migration without replacing Pixelspace data", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const legacy = path.join(fx.volumeRoot, "salurai_rustfs-data");
    const current = path.join(fx.volumeRoot, "pixelspace_rustfs-data");
    mkdirSync(legacy);
    mkdirSync(current);
    writeFileSync(path.join(legacy, "object.bin"), "source snapshot");
    writeFileSync(path.join(current, "object.bin"), "newer Pixelspace data");
    setEnvValue(fx.envFile, "PIXELSPACE_RESOURCE_MIGRATION", "pending");

    const result = run(["install"], fx.env);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(path.join(current, "object.bin"), "utf8")).toBe("newer Pixelspace data");
    expect(() => statSync(legacy)).toThrow();
    expect(readFileSync(fx.envFile, "utf8")).toContain('PIXELSPACE_RESOURCE_MIGRATION="complete"');
  });

  test("defaults on-prem installs to a bootstrapped local administrator", () => {
    const fx = fixture();
    const passwordFile = path.join(fx.home, "admin-password");
    writeFileSync(passwordFile, "correct horse battery staple\n", { mode: 0o600 });
    const env = { ...fx.env, PIXELSPACE_AUTH_MODE: undefined };

    const result = run(
      ["install", "--admin-email", "Admin@Example.COM", "--admin-password-file", passwordFile],
      env,
    );

    expect(result.exitCode).toBe(0);
    const body = readFileSync(fx.envFile, "utf8");
    expect(body).toContain('AUTH_MODE="local"');
    expect(body).toContain('SUPER_ADMIN_EMAILS="admin@example.com"');
    const log = readFileSync(fx.dockerLog, "utf8");
    expect(log).toContain("local-admin.ts create --email admin@example.com");
    expect(log).not.toContain("correct horse battery staple");
    expect(body).not.toContain("correct horse battery staple");
  });

  test("requires an admin identity for unattended local setup", () => {
    const fx = fixture();
    const result = run(["install", "--dry-run"], {
      ...fx.env,
      PIXELSPACE_AUTH_MODE: undefined,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("local auth requires --admin-email");
  });

  test("resets a local admin password without exposing it in process arguments", () => {
    const fx = fixture();
    const passwordFile = path.join(fx.home, "admin-password");
    writeFileSync(passwordFile, "a completely new password\n", { mode: 0o600 });
    expect(
      run(
        ["install", "--admin-email", "admin@example.com", "--admin-password-file", passwordFile],
        { ...fx.env, PIXELSPACE_AUTH_MODE: "local", PIXELSPACE_TEST_ADMIN_EXISTS: "1" },
      ).exitCode,
    ).toBe(0);

    const result = run(
      ["reset-admin-password", "--admin-email", "admin@example.com", "--admin-password-file", passwordFile],
      { ...fx.env, PIXELSPACE_AUTH_MODE: undefined, PIXELSPACE_TEST_ADMIN_EXISTS: "1" },
    );
    expect(result.exitCode).toBe(0);
    const log = readFileSync(fx.dockerLog, "utf8");
    expect(log).toContain("local-admin.ts reset --email admin@example.com");
    expect(log).not.toContain("a completely new password");
  });

  test("requires HTTPS when local password auth is exposed beyond loopback", () => {
    const fx = fixture();
    const result = run(
      [
        "install",
        "--dry-run",
        "--auth-mode",
        "local",
        "--admin-email",
        "admin@example.com",
        "--bind-address",
        "0.0.0.0",
      ],
      fx.env,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("requires an https PUBLIC_URL");
  });

  test("refuses unauthenticated LAN exposure", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const result = run(
      ["doctor", "--bind-address", "0.0.0.0", "--auth-mode", "dev"],
      fx.env,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("AUTH_MODE=dev may bind only to loopback");
  });

  test("accepts the DGX Spark profile on an ARM64 NVIDIA host", () => {
    const fx = fixture();
    const env = { ...fx.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" };
    expect(run(["install", "--profile", "dgx-spark", "--dry-run"], env).exitCode).toBe(0);
    const result = run(["doctor", "--profile", "dgx-spark"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("architecture: arm64");
  });

  test("configures the bundled Nemotron model pack on DGX Spark", () => {
    const fx = fixture();
    const env = { ...fx.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" };

    const result = run(
      ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
      env,
    );

    expect(result.exitCode).toBe(0);
    const body = readFileSync(fx.envFile, "utf8");
    expect(body).toContain('PIXELSPACE_MODEL_PACK="nemotron-3.5-lightning"');
    expect(body).toContain('CUSTOM_BASE_URL="http://model:8000/v1"');
    expect(body).toContain('CUSTOM_MODEL="nemotron-3.5-lightning"');
    expect(body).toContain('CUSTOM_API_KEY="local-no-auth"');
    expect(body).toContain(`PIXELSPACE_MODEL_CACHE_ROOT="${fx.home}/.cache/huggingface"`);
    expect(body).toContain("PIXELSPACE_MODEL_IMAGE=\"vllm/vllm-openai@sha256:");
    expect(readFileSync(fx.dockerLog, "utf8")).toContain("--profile dgx-model");
  });

  test("waits on Docker's model health status without repeated container probes", () => {
    const fx = fixture();
    const env = {
      ...fx.env,
      PIXELSPACE_ARCH_OVERRIDE: "aarch64",
      PIXELSPACE_SKIP_HEALTHCHECK: "0",
      PIXELSPACE_TEST_MODEL_HEALTHY: "1",
      PIXELSPACE_TEST_RUNNING_SERVICES: "1",
    };

    const result = run(
      ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning"],
      env,
    );

    expect(result.exitCode).toBe(0);
    const log = readFileSync(fx.dockerLog, "utf8");
    expect(log).toContain("inspect --format");
    expect(log).not.toContain("exec -T model python3");
  });

  test("fails immediately when the bundled model container exits", () => {
    const fx = fixture();
    const env = {
      ...fx.env,
      PIXELSPACE_ARCH_OVERRIDE: "aarch64",
      PIXELSPACE_SKIP_HEALTHCHECK: "0",
      PIXELSPACE_TEST_MODEL_STATE: "exited unhealthy",
      PIXELSPACE_TEST_RUNNING_SERVICES: "1",
    };

    const result = run(
      ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning"],
      env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("bundled model container exited");
    expect(readFileSync(fx.dockerLog, "utf8")).toContain("logs --tail 80 model");
  });

  test("reports a missing bundled model container before application setup", () => {
    const fx = fixture();
    const env = {
      ...fx.env,
      PIXELSPACE_ARCH_OVERRIDE: "aarch64",
      PIXELSPACE_SKIP_HEALTHCHECK: "0",
    };

    const result = run(
      ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning"],
      env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("bundled model container is not running");
    expect(readFileSync(fx.dockerLog, "utf8")).toContain("logs --tail 80 model");
  });

  test("keeps a bundled model pack explicit and DGX-only", () => {
    const core = fixture();
    const wrongProfile = run(
      ["install", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
      core.env,
    );
    expect(wrongProfile.exitCode).toBe(1);
    expect(wrongProfile.stderr.toString()).toContain("requires --profile dgx-spark");

    const conflicting = fixture();
    const conflict = run(
      [
        "install",
        "--profile",
        "dgx-spark",
        "--model-pack",
        "nemotron-3.5-lightning",
        "--model-url",
        "http://model.example/v1",
        "--dry-run",
      ],
      { ...conflicting.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" },
    );
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr.toString()).toContain("cannot be combined with --model-url or --model-id");
  });

  test("preserves and validates an existing bundled model pack", () => {
    const fx = fixture();
    const env = { ...fx.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" };
    expect(
      run(
        ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
        env,
      ).exitCode,
    ).toBe(0);

    expect(run(["install", "--dry-run"], env).exitCode).toBe(0);
    expect(readFileSync(fx.envFile, "utf8")).toContain(
      'PIXELSPACE_MODEL_PACK="nemotron-3.5-lightning"',
    );

    setEnvValue(fx.envFile, "PIXELSPACE_MODEL_IMAGE", "vllm/vllm-openai:latest");
    const invalid = run(["doctor"], env);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toContain(
      "PIXELSPACE_MODEL_IMAGE must use an immutable @sha256 digest",
    );

    setEnvValue(
      fx.envFile,
      "PIXELSPACE_MODEL_IMAGE",
      `vllm/vllm-openai@sha256:${"a".repeat(64)}`,
    );
    setEnvValue(fx.envFile, "PIXELSPACE_MODEL_CACHE_ROOT", "relative/cache");
    setEnvValue(fx.envFile, "PIXELSPACE_MODEL_STARTUP_TIMEOUT_SECONDS", "30");
    const invalidRuntime = run(["doctor"], env);
    expect(invalidRuntime.exitCode).toBe(1);
    expect(invalidRuntime.stderr.toString()).toContain(
      "PIXELSPACE_MODEL_CACHE_ROOT must be an absolute path",
    );
    expect(invalidRuntime.stderr.toString()).toContain(
      "PIXELSPACE_MODEL_STARTUP_TIMEOUT_SECONDS must be between 60 and 7200",
    );
  });

  test("removes the managed model container when switching to an external gateway", () => {
    const fx = fixture();
    const env = { ...fx.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" };
    expect(
      run(
        ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
        env,
      ).exitCode,
    ).toBe(0);
    writeFileSync(fx.dockerLog, "");

    const result = run(
      [
        "install",
        "--model-pack",
        "external",
        "--model-url",
        "https://gateway.example/v1",
        "--model-id",
        "external-model",
        "--dry-run",
      ],
      env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("--profile dgx-model rm -s -f model");
  });

  test("requires a reachable gateway when disabling the bundled model", () => {
    const fx = fixture();
    const env = { ...fx.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" };
    expect(
      run(
        ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
        env,
      ).exitCode,
    ).toBe(0);

    const result = run(["install", "--model-pack", "external", "--dry-run"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "disabling the bundled model requires --model-url",
    );
  });

  test("updates external model settings in the effective application env", () => {
    const fx = fixture();
    const env = { ...fx.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" };
    expect(
      run(
        ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
        env,
      ).exitCode,
    ).toBe(0);
    const appEnv = readFileSync(fx.envFile, "utf8").match(
      /^PIXELSPACE_APP_ENV_FILE="([^"]+)"$/m,
    )?.[1];
    expect(appEnv).toBeDefined();
    mkdirSync(path.dirname(appEnv!), { recursive: true });
    writeFileSync(
      appEnv!,
      'CUSTOM_BASE_URL="http://model:8000/v1"\nCUSTOM_MODEL="nemotron-3.5-lightning"\n',
      { mode: 0o600 },
    );

    const result = run(
      [
        "install",
        "--model-pack",
        "external",
        "--model-url",
        "https://gateway.example/v1",
        "--model-id",
        "external-model",
        "--dry-run",
      ],
      env,
    );

    expect(result.exitCode).toBe(0);
    const effective = readFileSync(appEnv!, "utf8");
    expect(effective).toContain('CUSTOM_BASE_URL="https://gateway.example/v1"');
    expect(effective).toContain('CUSTOM_MODEL="external-model"');
  });

  test("preserves an existing DGX profile when reinstalling without a profile flag", () => {
    const fx = fixture();
    const env = { ...fx.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" };
    expect(run(["install", "--profile", "dgx-spark", "--dry-run"], env).exitCode).toBe(0);
    expect(run(["install", "--dry-run"], env).exitCode).toBe(0);
    expect(readFileSync(fx.envFile, "utf8")).toContain('PIXELSPACE_PROFILE="dgx-spark"');
  });

  test("fills missing installer keys without replacing existing secrets", () => {
    const fx = fixture();
    const appEnv = path.join(fx.home, "app.env");
    writeFileSync(
      fx.envFile,
      `S3_SECRET_KEY="keep-me"\nAUTH_MODE="dev"\nPIXELSPACE_APP_ENV_FILE="${appEnv}"\n`,
      { mode: 0o600 },
    );
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const body = readFileSync(fx.envFile, "utf8");
    expect(body).toContain('S3_SECRET_KEY="keep-me"');
    expect(body).toContain(`PIXELSPACE_BACKUP_ROOT="${fx.home}/pixelspace-backups"`);
    expect(body).toContain(`PIXELSPACE_APP_ENV_FILE="${appEnv}"`);
  });

  test("keeps an installer-derived public URL aligned with a changed port", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);

    expect(run(["install", "--dry-run", "--port", "9090"], fx.env).exitCode).toBe(0);

    const body = readFileSync(fx.envFile, "utf8");
    expect(body).toContain('WEB_PORT="9090"');
    expect(body).toContain('PUBLIC_URL="http://127.0.0.1:9090"');
  });

  test("preserves an explicitly configured public URL when the port changes", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run", "--public-url", "https://pixelspace.example"], fx.env).exitCode).toBe(0);

    expect(run(["install", "--dry-run", "--port", "9090"], fx.env).exitCode).toBe(0);

    expect(readFileSync(fx.envFile, "utf8")).toContain('PUBLIC_URL="https://pixelspace.example"');
  });

  test("doctor validates every configured administrator email", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    setEnvValue(fx.envFile, "SUPER_ADMIN_EMAILS", "admin@example.com,not-an-email");

    const result = run(["doctor"], fx.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("SUPER_ADMIN_EMAILS contains an invalid email address");
  });

  test("adopts the legacy database path instead of disconnecting existing data", () => {
    const fx = fixture();
    writeFileSync(fx.envFile, 'REPO_ROOT="/opt/pixelspace"\nAUTH_MODE="dev"\n', { mode: 0o600 });
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    expect(readFileSync(fx.envFile, "utf8")).toContain('PIXELSPACE_DATA_ROOT="/opt/pixelspace/apps/api/data"');
  });

  test("replaces empty required secret placeholders", () => {
    const fx = fixture();
    const appEnv = path.join(fx.home, "app.env");
    writeFileSync(
      fx.envFile,
      `CONNECTION_SECRET=""\nS3_SECRET_KEY=""\nAUTH_MODE="dev"\nPIXELSPACE_APP_ENV_FILE="${appEnv}"\n`,
      { mode: 0o600 },
    );
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const body = readFileSync(fx.envFile, "utf8");
    expect(body).not.toContain('CONNECTION_SECRET=""');
    expect(body).not.toContain('S3_SECRET_KEY=""');
  });

  test("image mode reuses locally loaded digest images", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const digest = "a".repeat(64);
    setEnvValue(fx.envFile, "PIXELSPACE_API_IMAGE", `registry/pixelspace-api@sha256:${digest}`);
    setEnvValue(fx.envFile, "PIXELSPACE_WEB_IMAGE", `registry/pixelspace-web@sha256:${digest}`);
    setEnvValue(fx.envFile, "SANDBOX_IMAGE", `registry/pixelspace-sandbox@sha256:${digest}`);
    expect(run(["install", "--deploy-mode", "images"], fx.env).exitCode).toBe(0);
    const log = readFileSync(fx.dockerLog, "utf8");
    expect(log).toContain("up -d --no-build --pull missing");
    expect(log).not.toMatch(/^pull /m);
    expect(log).not.toContain(" build ");
  });

  test("image mode rejects mutable image references", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const result = run(["doctor", "--deploy-mode", "images"], fx.env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("must use an immutable @sha256 digest");
  });

  test("backup refuses a mutable helper in image mode before reading private data", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    setEnvValue(fx.envFile, "PIXELSPACE_DEPLOY_MODE", "images");
    const result = run(["backup", path.join(fx.home, "mutable-helper.tar.gz")], fx.env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("immutable @sha256 digest before it can access backups");
    expect(readFileSync(fx.dockerLog, "utf8")).not.toContain(" stop ");
  });

  test("rejects dry-run for stateful lifecycle commands", () => {
    const fx = fixture();
    const result = run(["restore", "--dry-run", path.join(fx.home, "backup.tar.gz"), "--yes"], fx.env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--dry-run is supported only for install");
  });

  test("rejects a host-loopback model URL", () => {
    const fx = fixture();
    expect(
      run(["install", "--model-url", "http://127.0.0.1:8000/v1", "--dry-run"], fx.env)
        .exitCode,
    ).toBe(1);
    const result = run(["doctor"], fx.env);
    expect(result.stderr.toString()).toContain("container cannot reach a host model bound to loopback");
  });

  test("rejects an expanded IPv6 loopback model URL", () => {
    const fx = fixture();
    const result = run(
      ["install", "--model-url", "http://[0:0:0:0:0:0:0:1]:8000/v1", "--dry-run"],
      fx.env,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("container cannot reach a host model bound to loopback");
  });

  test("rejects loopback model URLs from the effective application env", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const body = readFileSync(fx.envFile, "utf8");
    const appEnv = body.match(/^PIXELSPACE_APP_ENV_FILE="([^"]+)"$/m)?.[1];
    expect(appEnv).toBeDefined();
    mkdirSync(path.dirname(appEnv!), { recursive: true });
    writeFileSync(appEnv!, 'CUSTOM_BASE_URL="HTTP://127.0.0.2:8000/v1"\n', { mode: 0o600 });
    const result = run(["doctor"], fx.env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("container cannot reach a host model bound to loopback");
  });

  test("treats an empty application-env auth mode as an invalid runtime override", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    setEnvValue(fx.envFile, "AUTH_MODE", "proxy");
    setEnvValue(fx.envFile, "WEB_BIND_ADDRESS", "0.0.0.0");
    const appEnv = readFileSync(fx.envFile, "utf8").match(/^PIXELSPACE_APP_ENV_FILE="([^"]+)"$/m)?.[1];
    expect(appEnv).toBeDefined();
    mkdirSync(path.dirname(appEnv!), { recursive: true });
    writeFileSync(appEnv!, 'AUTH_MODE=""\n', { mode: 0o600 });

    const result = run(["doctor"], { ...fx.env, PIXELSPACE_AUTH_MODE: undefined });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("AUTH_MODE must be proxy, local, or dev");
  });

  test("uses a bracketed IPv6 address for health checks and display", () => {
    const fx = fixture();
    const result = run(
      ["install", "--bind-address", "::1"],
      { ...fx.env, PIXELSPACE_SKIP_HEALTHCHECK: "0" },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(fx.curlLog, "utf8")).toContain("http://[::1]:8080/api/meta");
    expect(result.stdout.toString()).toContain("Open Pixelspace: http://[::1]:8080");
  });

  test("restore is gated before touching the stack", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const archive = path.join(fx.home, "backup.tar.gz");
    writeFileSync(archive, "not read without confirmation");
    const result = run(["restore", archive], fx.env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("rerun with --yes");
  });

  test("rejects unsafe links before restore changes current data", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const dataRoot = path.join(fx.home, ".local", "share", "pixelspace", "data");
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "app.db"), "current");
    const payload = path.join(fx.home, "unsafe-payload");
    const inner = path.join(fx.home, "unsafe-data");
    mkdirSync(payload);
    mkdirSync(inner);
    writeFileSync(path.join(payload, "metadata"), "created_at=test\n");
    writeFileSync(path.join(payload, "pixelspace.env"), "AUTH_MODE=dev\n");
    writeFileSync(path.join(payload, "payloads"), "pixelspace.env\ndata.tar\nworkspaces.tar\n");
    symlinkSync("/etc/passwd", path.join(inner, "app.db"));
    createTar(inner, path.join(payload, "data.tar"));
    const emptyWorkspaces = path.join(fx.home, "empty-workspaces");
    mkdirSync(emptyWorkspaces);
    createTar(emptyWorkspaces, path.join(payload, "workspaces.tar"));
    const archive = path.join(fx.home, "unsafe.tar.gz");
    createTar(payload, archive, true);

    const result = run(["restore", archive, "--yes"], fx.env);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(path.join(dataRoot, "app.db"), "utf8")).toBe("current");
    expect(readFileSync(fx.dockerLog, "utf8")).not.toContain(" down ");
  });

  test("backup and restore round-trip persistent files", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const dataRoot = path.join(fx.home, ".local", "share", "pixelspace", "data");
    const workspaceRoot = path.join(fx.home, ".local", "share", "pixelspace", "workspaces");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    const rustfsVolume = path.join(fx.volumeRoot, "pixelspace_rustfs-data");
    const mcpVolume = path.join(fx.volumeRoot, "pixelspace_mcp-cache");
    mkdirSync(rustfsVolume);
    mkdirSync(mcpVolume);
    writeFileSync(path.join(dataRoot, "app.db"), "database-before");
    writeFileSync(path.join(workspaceRoot, "note.txt"), "workspace-before");
    writeFileSync(path.join(rustfsVolume, "object.bin"), "object-before");
    writeFileSync(path.join(mcpVolume, "package.bin"), "package-before");
    const initialEnv = readFileSync(fx.envFile, "utf8");
    const originalSecret = initialEnv.match(/^CONNECTION_SECRET="([^"]+)"$/m)?.[1];
    const appEnv = initialEnv.match(/^PIXELSPACE_APP_ENV_FILE="([^"]+)"$/m)?.[1];
    expect(originalSecret).toBeDefined();
    expect(appEnv).toBeDefined();
    writeFileSync(appEnv!, 'AUTH_MODE="dev"\nCUSTOM_MODEL="source-model"\n', { mode: 0o600 });
    const archive = path.join(fx.home, "round-trip.tar.gz");

    expect(run(["backup", archive], fx.env).exitCode).toBe(0);
    expect(statSync(path.join(fx.home, "pixelspace-backups")).mode & 0o777).toBe(0o700);
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(statSync(`${archive}.sha256`).mode & 0o777).toBe(0o600);
    writeFileSync(path.join(dataRoot, "app.db"), "database-after");
    writeFileSync(path.join(workspaceRoot, "note.txt"), "workspace-after");
    writeFileSync(path.join(rustfsVolume, "object.bin"), "object-after");
    writeFileSync(path.join(mcpVolume, "package.bin"), "package-after");
    setEnvValue(fx.envFile, "CONNECTION_SECRET", "destination-secret");
    setEnvValue(fx.envFile, "WEB_PORT", "9090");
    writeFileSync(appEnv!, 'AUTH_MODE="proxy"\nCUSTOM_MODEL="destination-model"\n', { mode: 0o600 });
    const restore = run(["restore", archive, "--yes"], fx.env);
    expect(restore.stderr.toString()).toBe("");
    expect(restore.exitCode).toBe(0);

    expect(readFileSync(path.join(dataRoot, "app.db"), "utf8")).toBe("database-before");
    expect(readFileSync(path.join(workspaceRoot, "note.txt"), "utf8")).toBe("workspace-before");
    expect(readFileSync(path.join(rustfsVolume, "object.bin"), "utf8")).toBe("object-before");
    expect(readFileSync(path.join(mcpVolume, "package.bin"), "utf8")).toBe("package-before");
    const restoredEnv = readFileSync(fx.envFile, "utf8");
    expect(restoredEnv).toContain(`CONNECTION_SECRET="${originalSecret}"`);
    expect(restoredEnv).toContain('WEB_PORT="9090"');
    expect(readFileSync(appEnv!, "utf8")).toContain('CUSTOM_MODEL="source-model"');
    expect(readFileSync(appEnv!, "utf8")).toContain('AUTH_MODE="proxy"');
  });

  test("rejects an incomplete backup before restore cutover", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const dataRoot = path.join(fx.home, ".local", "share", "pixelspace", "data");
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "app.db"), "current-state");
    const complete = path.join(fx.home, "complete.tar.gz");
    expect(run(["backup", complete], fx.env).exitCode).toBe(0);

    const unpacked = path.join(fx.home, "unpacked");
    mkdirSync(unpacked);
    expect(Bun.spawnSync(["tar", "-C", unpacked, "-xzf", complete]).exitCode).toBe(0);
    rmSync(path.join(unpacked, "data.tar"));
    const incomplete = path.join(fx.home, "incomplete.tar.gz");
    createTar(unpacked, incomplete, true);

    const result = run(["restore", incomplete, "--yes"], fx.env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("backup payload is missing: data.tar");
    expect(readFileSync(path.join(dataRoot, "app.db"), "utf8")).toBe("current-state");
    expect(readFileSync(fx.dockerLog, "utf8")).not.toContain(" down ");
  });

  test("restore preserves the host-approved bundled model image", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const archivedImage = `registry.example/attacker@sha256:${"a".repeat(64)}`;
    const approvedImage = `registry.example/vllm@sha256:${"b".repeat(64)}`;
    setEnvValue(fx.envFile, "PIXELSPACE_MODEL_IMAGE", archivedImage);
    const archive = path.join(fx.home, "model-image.tar.gz");
    expect(run(["backup", archive], fx.env).exitCode).toBe(0);
    setEnvValue(fx.envFile, "PIXELSPACE_MODEL_IMAGE", approvedImage);

    expect(run(["restore", archive, "--yes"], fx.env).exitCode).toBe(0);

    expect(readFileSync(fx.envFile, "utf8")).toContain(`PIXELSPACE_MODEL_IMAGE="${approvedImage}"`);
    expect(readFileSync(fx.envFile, "utf8")).not.toContain(archivedImage);
  });

  test("restore validates archived model-pack settings before startup", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    setEnvValue(fx.envFile, "PIXELSPACE_MODEL_PACK", "unknown-pack");
    const archive = path.join(fx.home, "invalid-model-pack.tar.gz");
    expect(run(["backup", archive], fx.env).exitCode).toBe(0);
    setEnvValue(fx.envFile, "PIXELSPACE_MODEL_PACK", "external");

    const result = run(["restore", archive, "--yes"], fx.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "PIXELSPACE_MODEL_PACK must be external or nemotron-3.5-lightning",
    );
    expect(readFileSync(fx.envFile, "utf8")).toContain('PIXELSPACE_MODEL_PACK="external"');
  });

  test("restoring an intentionally absent volume clears destination state", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const archive = path.join(fx.home, "without-volumes.tar.gz");
    expect(run(["backup", archive], fx.env).exitCode).toBe(0);

    const destination = path.join(fx.volumeRoot, "pixelspace_rustfs-data");
    mkdirSync(destination);
    writeFileSync(path.join(destination, "stale-object"), "stale");

    expect(run(["restore", archive, "--yes"], fx.env).exitCode).toBe(0);
    expect(() => readFileSync(path.join(destination, "stale-object"))).toThrow();
  });

  test("rolls current state back when restore cutover fails", () => {
    const fx = fixture();
    const env = {
      ...fx.env,
      PIXELSPACE_ARCH_OVERRIDE: "aarch64",
      PIXELSPACE_SKIP_HEALTHCHECK: "0",
      PIXELSPACE_TEST_MODEL_HEALTHY: "1",
      PIXELSPACE_TEST_RUNNING_SERVICES: "1",
    };
    expect(
      run(
        ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
        env,
      ).exitCode,
    ).toBe(0);
    const dataRoot = path.join(fx.home, ".local", "share", "pixelspace", "data");
    const workspaceRoot = path.join(fx.home, ".local", "share", "pixelspace", "workspaces");
    const rustfsVolume = path.join(fx.volumeRoot, "pixelspace_rustfs-data");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(rustfsVolume);
    writeFileSync(path.join(dataRoot, "app.db"), "archive-state");
    writeFileSync(path.join(rustfsVolume, "object.bin"), "archive-object");
    const archive = path.join(fx.home, "rollback-target.tar.gz");
    expect(run(["backup", archive], fx.env).exitCode).toBe(0);
    writeFileSync(path.join(dataRoot, "app.db"), "current-state");
    writeFileSync(path.join(rustfsVolume, "object.bin"), "current-object");

    const result = run(
      ["restore", archive, "--yes"],
      { ...env, PIXELSPACE_TEST_RESTORE_FAIL_ONCE: path.join(fx.home, "restore-failed") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("restore rollback completed");
    expect(readFileSync(path.join(dataRoot, "app.db"), "utf8")).toBe("current-state");
    expect(readFileSync(path.join(rustfsVolume, "object.bin"), "utf8")).toBe("current-object");
    expect(readFileSync(fx.dockerLog, "utf8")).toContain("inspect --format");
  });

  test("restore can preserve all destination configuration", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const dataRoot = path.join(fx.home, ".local", "share", "pixelspace", "data");
    const workspaceRoot = path.join(fx.home, ".local", "share", "pixelspace", "workspaces");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "app.db"), "before");
    const appEnv = readFileSync(fx.envFile, "utf8").match(/^PIXELSPACE_APP_ENV_FILE="([^"]+)"$/m)?.[1];
    expect(appEnv).toBeDefined();
    writeFileSync(appEnv!, 'CUSTOM_MODEL="source-model"\n', { mode: 0o600 });
    const archive = path.join(fx.home, "no-config.tar.gz");
    expect(run(["backup", archive], fx.env).exitCode).toBe(0);
    setEnvValue(fx.envFile, "CONNECTION_SECRET", "destination-secret");
    writeFileSync(appEnv!, 'CUSTOM_MODEL="destination-model"\n', { mode: 0o600 });

    expect(run(["restore", archive, "--yes", "--no-restore-config"], fx.env).exitCode).toBe(0);
    expect(readFileSync(fx.envFile, "utf8")).toContain('CONNECTION_SECRET="destination-secret"');
    expect(readFileSync(appEnv!, "utf8")).toContain('CUSTOM_MODEL="destination-model"');
  });

  test("verifies a backup after the archive and checksum are relocated", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const original = path.join(fx.home, "original.tar.gz");
    expect(run(["backup", original], fx.env).exitCode).toBe(0);
    const movedDirectory = path.join(fx.home, "moved");
    mkdirSync(movedDirectory);
    const moved = path.join(movedDirectory, "renamed.tar.gz");
    renameSync(original, moved);
    renameSync(`${original}.sha256`, `${moved}.sha256`);
    expect(run(["restore", moved, "--yes"], fx.env).exitCode).toBe(0);
  });

  test("uninstall preserves data unless purge is confirmed", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const dataRoot = path.join(fx.home, ".local", "share", "pixelspace", "data");
    const workspaceRoot = path.join(fx.home, ".local", "share", "pixelspace", "workspaces");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "app.db"), "keep");
    writeFileSync(path.join(workspaceRoot, "note.txt"), "keep");

    expect(run(["uninstall"], fx.env).exitCode).toBe(0);
    expect(readFileSync(path.join(dataRoot, "app.db"), "utf8")).toBe("keep");
    expect(run(["uninstall", "--purge"], fx.env).exitCode).toBe(1);
    expect(readFileSync(path.join(workspaceRoot, "note.txt"), "utf8")).toBe("keep");
    expect(run(["uninstall", "--purge", "--yes"], fx.env).exitCode).toBe(0);
    expect(() => readFileSync(path.join(dataRoot, "app.db"))).toThrow();
    expect(() => readFileSync(path.join(workspaceRoot, "note.txt"))).toThrow();
  });

  test("refuses canonical destructive paths before stopping the stack", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    setEnvValue(fx.envFile, "PIXELSPACE_DATA_ROOT", `${fx.home}/.`);
    const result = run(["uninstall", "--purge", "--yes"], fx.env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("refusing to clear unsafe path");
    expect(readFileSync(fx.dockerLog, "utf8")).not.toContain(" down -v");
  });

  test("upgrade validates image pins and preloads a changed sandbox helper", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const digest = "b".repeat(64);
    setEnvValue(fx.envFile, "PIXELSPACE_DEPLOY_MODE", "images");
    setEnvValue(fx.envFile, "PIXELSPACE_API_IMAGE", `registry/api@sha256:${digest}`);
    setEnvValue(fx.envFile, "PIXELSPACE_WEB_IMAGE", `registry/web@sha256:${digest}`);
    setEnvValue(fx.envFile, "SANDBOX_IMAGE", `registry/sandbox@sha256:${digest}`);
    const result = run(
      ["upgrade"],
      { ...fx.env, PIXELSPACE_TEST_MISSING_IMAGES: "1", PIXELSPACE_TEST_RUNNING_SERVICES: "1" },
    );
    expect(result.exitCode).toBe(0);
    const log = readFileSync(fx.dockerLog, "utf8");
    expect(log).toContain(`pull registry/sandbox@sha256:${digest}`);
    expect(log.indexOf("pull registry/sandbox")).toBeLessThan(log.indexOf(" stop "));
  });

  test("upgrade prepares and verifies the bundled model lifecycle", () => {
    const fx = fixture();
    const env = {
      ...fx.env,
      PIXELSPACE_ARCH_OVERRIDE: "aarch64",
      PIXELSPACE_SKIP_HEALTHCHECK: "0",
      PIXELSPACE_TEST_MODEL_HEALTHY: "1",
      PIXELSPACE_TEST_RUNNING_SERVICES: "1",
    };
    expect(
      run(
        ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
        env,
      ).exitCode,
    ).toBe(0);
    writeFileSync(fx.dockerLog, "");

    expect(run(["upgrade"], env).exitCode).toBe(0);

    const log = readFileSync(fx.dockerLog, "utf8");
    expect(log).toContain("--profile dgx-model");
    expect(log).toContain("image inspect vllm/vllm-openai@sha256:");
    expect(log).toContain("inspect --format");
  });

  test("backup quiesces and restarts workspace sandboxes", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const result = run(
      ["backup", path.join(fx.home, "sandbox.tar.gz")],
      { ...fx.env, PIXELSPACE_TEST_SANDBOX_CONTAINER: "sandbox-container-id" },
    );
    expect(result.exitCode).toBe(0);
    const log = readFileSync(fx.dockerLog, "utf8");
    expect(log).toContain("stop sandbox-container-id");
    expect(log).toContain("start sandbox-container-id");
  });

  test("backup aborts before stopping services when service state is unknown", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const result = run(
      ["backup", path.join(fx.home, "unknown-state.tar.gz")],
      { ...fx.env, PIXELSPACE_TEST_COMPOSE_PS_FAIL: "1" },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("could not determine whether the api service is running");
    expect(readFileSync(fx.dockerLog, "utf8")).not.toContain(" stop ");
  });

  test("backup reports volume inspection and service recovery failures", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const env = {
      ...fx.env,
      PIXELSPACE_TEST_RUNNING_SERVICES: "1",
      PIXELSPACE_TEST_VOLUME_INSPECT_FAIL: "1",
      PIXELSPACE_TEST_VOLUME_LIST_FAIL: "1",
      PIXELSPACE_TEST_RESTART_FAIL: "api",
    };
    const result = run(["backup", path.join(fx.home, "failed.tar.gz")], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("could not inspect Docker volume");
    expect(result.stderr.toString()).toContain("services still require manual recovery");
    expect(readFileSync(fx.dockerLog, "utf8")).toContain("start api");
  });

  test("backup checks its helper image before stopping services", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const result = run(
      ["backup", path.join(fx.home, "missing-helper.tar.gz")],
      { ...fx.env, PIXELSPACE_TEST_MISSING_IMAGES: "1", PIXELSPACE_TEST_RUNNING_SERVICES: "1" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("backup helper image is unavailable");
    expect(readFileSync(fx.dockerLog, "utf8")).not.toContain(" stop ");
  });

  test("the generated environment renders the Compose model", () => {
    const fx = fixture();
    expect(run(["install", "--dry-run"], fx.env).exitCode).toBe(0);
    const result = Bun.spawnSync(
      ["docker", "compose", "--project-directory", root, "--env-file", fx.envFile, "-f", path.join(root, "docker-compose.yml"), "config", "-q"],
      {
        cwd: root,
        env: { ...process.env, PIXELSPACE_DEPLOY_ENV_FILE: fx.envFile },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("the bundled model renders on a private Compose network", () => {
    const fx = fixture();
    const env = { ...fx.env, PIXELSPACE_ARCH_OVERRIDE: "aarch64" };
    expect(
      run(
        ["install", "--profile", "dgx-spark", "--model-pack", "nemotron-3.5-lightning", "--dry-run"],
        env,
      ).exitCode,
    ).toBe(0);
    const result = Bun.spawnSync(
      [
        "docker",
        "compose",
        "--project-directory",
        root,
        "--env-file",
        fx.envFile,
        "-f",
        path.join(root, "docker-compose.yml"),
        "--profile",
        "dgx-model",
        "config",
        "--format",
        "json",
      ],
      {
        cwd: root,
        env: { ...process.env, PIXELSPACE_DEPLOY_ENV_FILE: fx.envFile },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(result.stdout.toString()) as {
      services: Record<string, {
        ports?: unknown[];
        command?: string[];
        volumes?: Array<{ source: string; target: string }>;
      }>;
    };
    expect(config.services.model).toBeDefined();
    expect(config.services.model.ports).toBeUndefined();
    expect(config.services.model.command).toContain("nemotron-3.5-lightning");
    expect(config.services.model.volumes).toContainEqual({
      type: "volume",
      source: "vllm-cache",
      target: "/root/.cache/vllm",
      volume: {},
    });
  });

  test("Docker build context excludes generated application env files", () => {
    const patterns = readFileSync(path.join(root, ".dockerignore"), "utf8").split("\n");
    expect(patterns).toContain("**/app.env");
  });
});
