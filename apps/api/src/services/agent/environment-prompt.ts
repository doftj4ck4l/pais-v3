import { describePythonBaseline } from "../sandbox/python-baseline";

/**
 * Tell the model where it is.
 *
 * This exists because of a single asked question: "ls all file in this server"
 * went straight to `nc_webdav_list_directory` and listed a Nextcloud share. The
 * model was not preferring MCP over the sandbox — nothing in the system prompt
 * had ever mentioned a sandbox, so "this server" had exactly one possible
 * referent, and it was the MCP block naming Nextcloud.
 *
 * The MCP block describes connected external systems in detail. Without a
 * matching description of the machine the agent is actually running on, every
 * ambiguous locative resolves outward. This is the other half of that pair.
 */

export type EnvironmentDescription = {
  /** "pixelbox" gives the workspace its own remote sandbox; "node" runs on the API host. */
  backend: "pixelbox" | "node";
  /** The working directory the file and shell tools resolve against. */
  cwd: string;
  /** Whether any MCP server is connected, which is what makes "here" ambiguous. */
  hasExternalServices: boolean;
};

export function describeEnvironment(env: EnvironmentDescription): string {
  const place =
    env.backend === "pixelbox"
      ? `a Linux sandbox dedicated to this workspace`
      : `the API host`;

  let out =
    `\n\nYour working environment is ${place}. Its filesystem is at ${env.cwd} and you ` +
    `reach it with the "bash", "read", "write" and "edit" tools. This is the machine you ` +
    `are running on: "here", "this server", "this machine", "the workspace", and bare shell ` +
    `requests such as "ls" all mean this filesystem.`;

  // The other half of knowing where you are: knowing the user is not there.
  //
  // A run once drew a picture and reported its workspace path. The path was
  // correct and useless — it names a directory inside this container, which the
  // user has no shell on — so a finished piece of work read as a fabrication.
  // Naming the tool here rather than leaving it to the tool list is deliberate:
  // the failure was never that the model could not find `share_file`, it was
  // that a path felt like an answer.
  out +=
    ` The user cannot see this filesystem and cannot open a path on it. Any file you want ` +
    `them to have — an image, a document, a spreadsheet — has to go through the "share_file" ` +
    `tool, which returns a URL; give them that URL and never a bare path. Images come back as ` +
    `a link to embed as markdown so the picture shows in your reply. Always use "share_file" ` +
    `for this — do not upload the file to a connected service such as Nextcloud to "share" it ` +
    `unless the user explicitly names that service.`;

  // The shell and the platform are two different places, and the model conflates
  // them: a run tried to pipe `fetch_url`'s output through a bash command, and
  // `fetch_url` is not a program in this filesystem. Name the boundary so tools
  // are called as tools.
  out +=
    ` "bash" runs commands in this filesystem; the other tools — "fetch_url", "web_search", ` +
    `"search_docs", "read_image", and any skill — run in the platform, not the shell. Call ` +
    `them as tools; do not invoke them inside a bash command.`;

  // Tell the model what is actually in the box, and what is not.
  //
  // The Pixelbox coding image is deliberately minimal: python3, pip and git,
  // and little else — measured against the live service, it has no Node, no
  // curl/wget, no ImageMagick or ghostscript, and no C compiler. Cold sandbox
  // acquisition prewarms the common Python task libraries below as an app-level
  // bridge until Pixelbox exposes the equivalent image/session hook.
  //
  // Egress is open, so `python3 -m pip install --user --break-system-packages`
  // works for anything outside the baseline. It lasts while this sandbox
  // remains warm but not after the reaper replaces it. Only for the sandbox
  // backend; the node backend runs on the API host with whatever Python the
  // deploy happens to have.
  if (env.backend === "pixelbox") {
    out +=
      ` This sandbox starts from a minimal Debian Linux with python3, pip and git, but no Node, ` +
      `curl or wget, ImageMagick, or C compiler. The common Python libraries for ` +
      `${describePythonBaseline()} are already installed when the sandbox ` +
      `starts. Import them directly instead of reinstalling them. Reach for Python rather than ` +
      `a missing shell tool — use requests or urllib, not curl. If a task needs something outside ` +
      `that baseline, "python3 -m pip install --user --break-system-packages <name>" works for ` +
      `the life of this warm sandbox, but keep it to what the task needs and prefer the standard ` +
      `library where it will do.`;
  }

  // Only worth saying when there is something to confuse it with. A workspace
  // with no MCP server has no ambiguity to resolve.
  if (env.hasExternalServices) {
    out +=
      ` Any MCP server listed below is a separate, remote system — reaching it is a ` +
      `deliberate choice, not the default. When a request could mean either this machine ` +
      `or one of those services, use this machine unless the request names the service, ` +
      `and say which one you used.`;
  }

  return out;
}
