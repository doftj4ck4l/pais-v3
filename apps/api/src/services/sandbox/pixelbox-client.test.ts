import { describe, expect, test } from "bun:test";
import { PixelboxError, PixelboxSandboxClient } from "./pixelbox-client";

type Captured = { url: string; init: RequestInit & { headers: Headers } };

/** A fake fetch that records the last request and returns a canned response. */
function stub(response: Response): { fetch: typeof fetch; last?: Captured } {
  const box: { fetch: typeof fetch; last?: Captured } = {
    fetch: (async (input: any, init: any = {}) => {
      box.last = { url: String(input), init: { ...init, headers: new Headers(init.headers) } };
      return response;
    }) as unknown as typeof fetch,
  };
  return box;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const client = (fetchImpl: typeof fetch) =>
  new PixelboxSandboxClient({ baseUrl: "https://sb.test", token: "secret-token", fetchImpl });

describe("PixelboxSandboxClient.create", () => {
  test("POSTs a flat body with an Idempotency-Key and bearer auth", async () => {
    const s = stub(json({ sandbox_id: "sb-1", status: { state: "created" } }));
    const info = await client(s.fetch).create({ cpu: 1, memoryMiB: 2048, blockNetwork: true });

    expect(info.sandboxId).toBe("sb-1");
    expect(s.last!.url).toBe("https://sb.test/v1/sandboxes");
    expect(s.last!.init.method).toBe("POST");
    expect(s.last!.init.headers.get("authorization")).toBe("Bearer secret-token");
    expect(s.last!.init.headers.get("idempotency-key")).toBeTruthy();
    const body = JSON.parse(String(s.last!.init.body));
    expect(body.cpu).toBe(1);
    expect(body.blockNetwork).toBe(true);
    // The SDK wraps options; the raw HTTP body must be flat.
    expect(body.options).toBeUndefined();
  });
});

describe("PixelboxSandboxClient.execute", () => {
  test("maps timeout_seconds and returns timedOut", async () => {
    const s = stub(json({ stdout: "hi\n", stderr: "", exit_code: 0, timed_out: false }));
    const result = await client(s.fetch).execute("sb-1", { command: "echo hi", cwd: "/workspace", timeoutSeconds: 30 });

    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const body = JSON.parse(String(s.last!.init.body));
    expect(body.command).toBe("echo hi");
    expect(body.timeout_seconds).toBe(30);
    expect(s.last!.url).toBe("https://sb.test/v1/sandboxes/sb-1/execute");
  });
});

describe("PixelboxSandboxClient.stat", () => {
  test("returns null on 404 rather than throwing", async () => {
    const s = stub(json({ code: "NOT_FOUND" }, 404));
    const result = await client(s.fetch).stat("sb-1", "/workspace/gone");
    expect(result).toBeNull();
  });

  test("maps the service kind and mtime", async () => {
    const s = stub(json({ type: "dir", size: 0, mtime_ms: 42 }));
    const result = await client(s.fetch).stat("sb-1", "/workspace/d");
    expect(result).toEqual({ kind: "dir", size: 0, mtimeMs: 42 });
  });
});

describe("PixelboxSandboxClient error mapping", () => {
  test("a 422 INVALID_PATH becomes a PixelboxError with that code", async () => {
    const s = stub(json({ code: "INVALID_PATH", detail: "outside /workspace" }, 422));
    await expect(client(s.fetch).readBytes("sb-1", "/etc/passwd")).rejects.toMatchObject({
      name: "PixelboxError",
      code: "INVALID_PATH",
    });
  });

  test("readBytes on 404 throws NOT_FOUND", async () => {
    const s = stub(new Response("", { status: 404 }));
    await expect(client(s.fetch).readBytes("sb-1", "/workspace/gone")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("never puts the token in the request URL", async () => {
    const s = stub(json({ stdout: "", stderr: "", exit_code: 0, timed_out: false }));
    await client(s.fetch).execute("sb-1", { command: "true" });
    expect(s.last!.url).not.toContain("secret-token");
  });
});
