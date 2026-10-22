import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpCapabilityRow } from "../../models/schema";

export type McpApprovalRequest = {
  server: string;
  tool: string;
  destructive: boolean;
  question: string;
};

export type McpApprovalEntry = {
  serverName: string;
  remoteName: string;
  title: string | null;
  annotationsJson: string | null;
};

function toolAnnotations(json: string | null | undefined): ToolAnnotations {
  if (!json) return {};
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? (value as ToolAnnotations) : {};
  } catch {
    return {};
  }
}

const READ_ONLY_VERBS = new Set([
  "browse",
  "check",
  "download",
  "fetch",
  "find",
  "get",
  "info",
  "list",
  "lookup",
  "query",
  "read",
  "search",
  "stat",
  "status",
  "whoami",
]);

const MUTATING_VERBS = new Set([
  "add",
  "archive",
  "assign",
  "complete",
  "copy",
  "create",
  "delete",
  "edit",
  "expose",
  "import",
  "insert",
  "invite",
  "mark",
  "move",
  "post",
  "publish",
  "remove",
  "rename",
  "restore",
  "revoke",
  "send",
  "set",
  "trash",
  "unassign",
  "update",
  "upload",
  "write",
]);

const toolWords = (name: string): string[] =>
  name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Unknown names and untrusted or missing annotations always require approval. */
export function isReadOnlyMcpTool(
  remoteName: string,
  annotationsJson: string | null | undefined,
): boolean {
  const annotations = toolAnnotations(annotationsJson);
  if (annotations.readOnlyHint !== true) return false;
  const words = toolWords(remoteName);
  return (
    words.some((word) => READ_ONLY_VERBS.has(word)) &&
    !words.some((word) => MUTATING_VERBS.has(word))
  );
}

export function isNextcloudServer(
  row: {
    argsJson: string | null;
    name?: string | null;
    command?: string | null;
    url?: string | null;
  },
  caps: McpCapabilityRow[],
  envKeys: string[] = [],
): boolean {
  const configuredIdentity = [row.name, row.command, row.url].filter(Boolean).join(" ");
  if (/(?:^|[^a-z0-9])(?:nextcloud|nas)(?:$|[^a-z0-9])/i.test(configuredIdentity)) {
    return true;
  }
  try {
    const args = row.argsJson ? (JSON.parse(row.argsJson) as unknown) : [];
    if (
      Array.isArray(args) &&
      args.some(
        (arg) =>
          typeof arg === "string" &&
          (arg === "nextcloud-mcp-server" || arg.startsWith("nextcloud-mcp-server@")),
      )
    ) {
      return true;
    }
  } catch {
    // Malformed arguments fail when connecting; the other identity signals can
    // still put the server behind the approval policy.
  }
  return (
    envKeys.includes("NEXTCLOUD_HOST") ||
    caps.some((cap) => cap.kind === "tool" && cap.name.startsWith("nc_"))
  );
}

const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function safeDisplay(value: string, max: number): string {
  const clean = value.replace(UNSAFE_DISPLAY_CHARS, "").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function previewValue(value: unknown, depth = 0): string {
  if (typeof value === "string") {
    return JSON.stringify(safeDisplay(value, 120));
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (depth >= 2) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => previewValue(item, depth + 1));
    if (value.length > items.length) items.push("…");
    return `[${items.join(", ")}]`;
  }
  if (typeof value === "object") {
    const fields: string[] = [];
    for (const key in value as Record<string, unknown>) {
      if (!Object.hasOwn(value as object, key)) continue;
      if (fields.length === 4) {
        fields.push("…");
        break;
      }
      fields.push(
        `${JSON.stringify(safeDisplay(key, 80))}: ${previewValue((value as Record<string, unknown>)[key], depth + 1)}`,
      );
    }
    return `{${fields.join(", ")}}`;
  }
  return JSON.stringify(String(value));
}

function argumentPreview(args: Record<string, unknown>): string {
  const fields: string[] = [];
  for (const key in args) {
    if (!Object.hasOwn(args, key)) continue;
    if (fields.length === 6) {
      fields.push("…");
      break;
    }
    fields.push(`${safeDisplay(key, 80)}: ${previewValue(args[key])}`);
  }
  return fields.join("; ");
}

export function approvalRequest(
  entry: McpApprovalEntry,
  args: Record<string, unknown>,
): McpApprovalRequest {
  const annotations = toolAnnotations(entry.annotationsJson);
  const rawTitle = entry.title ?? annotations.title ?? entry.remoteName.replaceAll("_", " ");
  const title = safeDisplay(rawTitle, 120) || "Untitled action";
  const remoteName = safeDisplay(entry.remoteName, 160);
  const words = toolWords(entry.remoteName);
  const destructive =
    annotations.destructiveHint === true ||
    words.some((word) =>
      ["archive", "delete", "remove", "restore", "revoke", "trash"].includes(word),
    );
  const preview = argumentPreview(args);
  const server =
    entry.serverName.toLowerCase() === "nextcloud"
      ? "Nextcloud"
      : `MCP server (${safeDisplay(entry.serverName, 80)})`;
  const warning = destructive ? " This may permanently change or remove data." : "";
  return {
    server: entry.serverName,
    tool: entry.remoteName,
    destructive,
    question:
      `Allow ${server} to run “${title}” (tool: ${remoteName})?` +
      `${preview ? ` ${preview}.` : ""}${warning}`,
  };
}
