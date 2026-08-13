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
  /** "docker" gives the workspace its own container; "node" runs on the API host. */
  backend: "docker" | "node";
  /** The working directory the file and shell tools resolve against. */
  cwd: string;
  /** Whether any MCP server is connected, which is what makes "here" ambiguous. */
  hasExternalServices: boolean;
};

export function describeEnvironment(env: EnvironmentDescription): string {
  const place =
    env.backend === "docker"
      ? `a Linux container dedicated to this workspace`
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
    `a link to embed as markdown so the picture shows in your reply.`;

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
