/**
 * Local tools historically returned human-readable error strings as ordinary
 * successful results. Pi only marks a tool call failed when `execute` throws,
 * so those strings made failures look healthy in the run ledger and traces.
 *
 * Keep this deliberately narrow. Tools such as `echo`, `read`, `bash`, and MCP
 * calls can legitimately return arbitrary external text beginning with
 * "error:"; only app-owned structured tools are passed through this check.
 */
export function isSemanticToolFailure(toolName: string, result: string): boolean {
  if (toolName === "echo") return false;

  const text = result.trimStart();
  return (
    /^error(?::|\s+running\s+skill\b)/i.test(text) ||
    /^skill\s+"[^"]+"\s+exited\s+\d+\b/i.test(text) ||
    (toolName === "render_ui" && /^render_ui\s+rejected\b/i.test(text))
  );
}

/** Flatten a pi tool result into the text shown to the model and UI. */
export function toolResultText(result: any): string {
  try {
    const blocks = result?.content ?? [];
    return blocks
      .map((block: any) =>
        block?.type === "text" || block?.type === "thinking"
          ? (block.text ?? block.thinking ?? "")
          : "",
      )
      .join("\n");
  } catch {
    return String(result ?? "");
  }
}

/** Make pi's native error channel reflect an app-owned tool's text contract. */
export function promoteSemanticToolFailures<
  T extends { name: string; execute?: (...args: any[]) => any },
>(tool: T): T {
  if (typeof tool.execute !== "function") return tool;
  return {
    ...tool,
    execute: async (...args: any[]) => {
      const result = await tool.execute!.apply(tool, args);
      const text = toolResultText(result);
      if (isSemanticToolFailure(tool.name, text)) throw new Error(text);
      return result;
    },
  };
}
