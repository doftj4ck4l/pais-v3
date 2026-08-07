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
