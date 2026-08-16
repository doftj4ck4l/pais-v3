import { describe, expect, it } from "bun:test";
import { describeEnvironment } from "./environment-prompt";

const docker = { backend: "docker" as const, cwd: "/srv/pixelspace/sandboxes/ws1", hasExternalServices: true };

describe("describeEnvironment", () => {
  it("names the working directory the file tools actually resolve against", () => {
    // A model told it has a filesystem but not where it is will guess /home or
    // /app and read nothing.
    expect(describeEnvironment(docker)).toContain("/srv/pixelspace/sandboxes/ws1");
  });

  it("claims the locatives that used to resolve to the MCP server", () => {
    // "ls all file in this server" listed a Nextcloud share, because the MCP
    // block was the only thing in the prompt naming a place.
    const out = describeEnvironment(docker);
    expect(out).toContain("this server");
    expect(out).toContain('"ls"');
  });

  it("names the tools that reach it", () => {
    const out = describeEnvironment(docker);
    for (const tool of ["bash", "read", "write", "edit"]) expect(out).toContain(`"${tool}"`);
  });

  it("says the user cannot open a path on it, whatever else is configured", () => {
    // A run drew a picture and handed over its workspace path. Correct and
    // unreachable: the user has no shell on this container, so finished work
    // read as a fabrication.
    for (const external of [true, false]) {
      const out = describeEnvironment({ ...docker, hasExternalServices: external });
      expect(out).toContain("cannot see this filesystem");
      expect(out).toContain('"share_file"');
      expect(out).toContain("never a bare path");
    }
  });

  it("makes the local machine the default when external services exist", () => {
    const out = describeEnvironment(docker);
    expect(out).toContain("unless the request names the service");
    expect(out).toContain("say which one you used");
  });

  it("says nothing about ambiguity when there is no MCP server to confuse it with", () => {
    const out = describeEnvironment({ ...docker, hasExternalServices: false });
    expect(out).not.toContain("MCP");
    expect(out).not.toContain("unless the request names the service");
    // The directory still has to be named — that part is not conditional.
    expect(out).toContain("/srv/pixelspace/sandboxes/ws1");
  });

  it("names the preinstalled toolchain so a run does not reinstall it", () => {
    // Asked to edit an image, a run opened with `pip install` for packages the
    // image had all along — then paid it again after the reaper took the
    // container. Nothing in the prompt had ever mentioned them.
    const out = describeEnvironment(docker);
    for (const pkg of ["pillow", "pandas", "matplotlib", "python-docx", "magick"]) {
      expect(out).toContain(pkg);
    }
    expect(out).toContain("before installing");
  });

  it("claims nothing about the API host's Python", () => {
    // The node backend runs wherever the API runs; the sandbox image's package
    // list says nothing about that machine.
    expect(describeEnvironment({ ...docker, backend: "node" })).not.toContain("pillow");
  });

  it("distinguishes the container from the API host", () => {
    expect(describeEnvironment(docker)).toContain("container");
    expect(describeEnvironment({ ...docker, backend: "node" })).toContain("API host");
  });
});
