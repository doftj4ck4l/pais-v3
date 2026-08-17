import type { McpConnection } from "./client";
import type { NewCapability } from "../../repositories/mcp.repository";
import { logger } from "../../lib/logger";

/**
 * Turn a live connection into the rows the cache stores.
 *
 * Each of the three lists is optional in MCP: a server that offers only tools
 * answers `resources/list` with an error, and that is not a failure. Each list
 * is therefore fetched independently and an absent one contributes nothing,
 * rather than aborting the probe.
 */

async function safely<T>(what: string, server: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    // Debug, not warn: "this server has no prompts" is the common case, and a
    // warning per run per server would drown the log.
    logger.debug("mcp.list_unsupported", {
      server,
      what,
      message: (e as Error)?.message,
    });
    return null;
  }
}

export async function listCapabilities(
  conn: McpConnection,
  options: { requireTools?: boolean; toolsOnly?: boolean } = {},
): Promise<NewCapability[]> {
  const server = conn.spec.name;
  const caps: NewCapability[] = [];

  // A normal probe tolerates unsupported capability families. A safety refresh
  // is different: replacing the cached tool policy after tools/list failed
  // would erase usable tools and turn an I/O failure into a false empty catalog.
  const tools = options.requireTools
    ? await conn.client.listTools()
    : await safely("tools", server, () => conn.client.listTools());
  for (const tool of tools?.tools ?? []) {
    caps.push({
      kind: "tool",
      name: tool.name,
      title: tool.title ?? tool.annotations?.title ?? null,
      description: tool.description ?? null,
      schemaJson: JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} }),
      // Store `{}` rather than null when the server deliberately sent no
      // annotations. Null is reserved for catalogs cached before this field
      // existed, so they can be re-probed exactly once after migration.
      annotationsJson: JSON.stringify(tool.annotations ?? {}),
    });
  }

  if (options.toolsOnly) return caps;

  const resources = await safely("resources", server, () => conn.client.listResources());
  for (const resource of resources?.resources ?? []) {
    caps.push({
      kind: "resource",
      name: resource.name ?? resource.uri,
      description: resource.description ?? null,
      uri: resource.uri,
    });
  }

  const prompts = await safely("prompts", server, () => conn.client.listPrompts());
  for (const prompt of prompts?.prompts ?? []) {
    caps.push({
      kind: "prompt",
      name: prompt.name,
      description: prompt.description ?? null,
      schemaJson: JSON.stringify(prompt.arguments ?? []),
    });
  }

  return caps;
}
