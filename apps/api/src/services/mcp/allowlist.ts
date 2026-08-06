/**
 * The security boundary for the stdio transport.
 *
 * A stdio MCP server is a process this API spawns, configured by whoever can
 * reach the API. Without a check, "add an MCP server" would mean "run any
 * command on the API host". This module is the check, and it is pure — no
 * spawning, no filesystem, no I/O — so all of it is testable directly.
 *
 * What this does NOT do: isolate what runs. An allowlisted launcher can still
 * fetch and execute an arbitrary package. The allowlist narrows the entry
 * point; it is not a sandbox. Real isolation would mean spawning inside the
 * workspace container, which is recorded as a known limitation in the design.
 */

/** Launchers a published MCP server is actually distributed behind. */
export const ALLOWED_STDIO_COMMANDS = [
  "npx",
  "uvx",
  "node",
  "python",
  "python3",
  "bun",
  "deno",
] as const;

/**
 * Flags that turn an allowlisted interpreter into "run this string".
 *
 * Without these, `node -e "..."` would pass the allowlist while being exactly
 * the arbitrary execution the allowlist exists to prevent. A server that needs
 * inline code is not a server; it is a script, and it can live in a file.
 */
const EVAL_FLAGS = new Set(["-e", "--eval", "-c", "--command", "eval", "-p", "--print"]);

/**
 * Anything that would change the meaning of the command if it ever reached a
 * shell. Nothing here is spawned through a shell — but a command containing
 * these is not a command name, so rejecting them keeps a mistake from becoming
 * a vulnerability if the spawn path ever changes.
 */
const SHELL_METACHARACTERS = /[;&|<>$`(){}[\]!*?~"'\\\s]/;

export type AllowResult = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a stdio server may be launched.
 *
 * The command must be a bare allowlisted name — not a path, not a shell, not
 * decorated with metacharacters — and its arguments must not ask an
 * interpreter to evaluate inline code.
 */
export function checkStdioCommand(command: string, args: string[] = []): AllowResult {
  const trimmed = String(command ?? "").trim();

  if (!trimmed) return { ok: false, reason: "A command is required for a stdio MCP server." };

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return {
      ok: false,
      reason: `"${trimmed}" is a path. Use a bare command name, e.g. "npx".`,
    };
  }

  if (SHELL_METACHARACTERS.test(trimmed)) {
    return { ok: false, reason: `"${trimmed}" is not a plain command name.` };
  }

  if (!(ALLOWED_STDIO_COMMANDS as readonly string[]).includes(trimmed)) {
    return {
      ok: false,
      reason:
        `"${trimmed}" is not allowed. Permitted commands: ` +
        `${ALLOWED_STDIO_COMMANDS.join(", ")}.`,
    };
  }

  for (const arg of args) {
    if (typeof arg !== "string") {
      return { ok: false, reason: "Every argument must be a string." };
    }
    if (EVAL_FLAGS.has(arg)) {
      return {
        ok: false,
        reason: `"${arg}" runs inline code, which is not permitted. Point at a script or package instead.`,
      };
    }
  }

  return { ok: true };
}
