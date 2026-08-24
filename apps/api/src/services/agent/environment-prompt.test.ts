import { describe, expect, it } from "bun:test";
import { describeEnvironment } from "./environment-prompt";

const sandbox = { backend: "pixelbox" as const, cwd: "/workspace", hasExternalServices: true };

describe("describeEnvironment", () => {
  it("names the working directory the file tools actually resolve against", () => {
    // A model told it has a filesystem but not where it is will guess /home or
    // /app and read nothing.
    expect(describeEnvironment(sandbox)).toContain("/workspace");
  });

  it("claims the locatives that used to resolve to the MCP server", () => {
    // "ls all file in this server" listed a Nextcloud share, because the MCP
    // block was the only thing in the prompt naming a place.
    const out = describeEnvironment(sandbox);
    expect(out).toContain("this server");
    expect(out).toContain('"ls"');
  });

  it("names the tools that reach it", () => {
    const out = describeEnvironment(sandbox);
    for (const tool of ["bash", "read", "write", "edit"]) expect(out).toContain(`"${tool}"`);
  });

  it("says the user cannot open a path on it, whatever else is configured", () => {
    // A run drew a picture and handed over its workspace path. Correct and
    // unreachable: the user has no shell on this container, so finished work
    // read as a fabrication.
    for (const external of [true, false]) {
      const out = describeEnvironment({ ...sandbox, hasExternalServices: external });
      expect(out).toContain("cannot see this filesystem");
      expect(out).toContain('"share_file"');
      expect(out).toContain("never a bare path");
      // Must steer sharing to share_file, not an MCP upload (the Nextcloud spiral).
      expect(out).toContain("do not upload the file to a connected service");
    }
  });

  it("makes the local machine the default when external services exist", () => {
    const out = describeEnvironment(sandbox);
    expect(out).toContain("unless the request names the service");
    expect(out).toContain("say which one you used");
  });

  it("says nothing about ambiguity when there is no MCP server to confuse it with", () => {
    const out = describeEnvironment({ ...sandbox, hasExternalServices: false });
    expect(out).not.toContain("MCP");
    expect(out).not.toContain("unless the request names the service");
    // The directory still has to be named — that part is not conditional.
    expect(out).toContain("/workspace");
  });

  it("names the Python packages prewarmed for every sandbox", () => {
    // Cold acquisition installs the common document, image, data and chart
    // libraries before the agent receives the sandbox. The prompt should keep
    // the model from paying for the same install again during its first task.
    const out = describeEnvironment(sandbox);
    expect(out).toContain("pip install");
    expect(out).toContain("pillow");
    expect(out).toContain("pandas");
    expect(out).toContain("reportlab");
    expect(out).toContain("already installed");
    expect(out).toContain("minimal");
    expect(out).toContain("python3 -m pip install --user --break-system-packages <name>");
    expect(out).not.toContain("NOT installed");
  });

  it("claims nothing about the API host's Python", () => {
    // The node backend runs wherever the API runs; the sandbox package guidance
    // says nothing about that machine.
    expect(describeEnvironment({ ...sandbox, backend: "node" })).not.toContain("pip install");
  });

  it("distinguishes the container from the API host", () => {
    expect(describeEnvironment(sandbox)).toContain("sandbox");
    expect(describeEnvironment({ ...sandbox, backend: "node" })).toContain("API host");
  });
});
