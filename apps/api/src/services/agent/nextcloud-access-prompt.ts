/** Guidance for the small set of NAS tools exposed behind an in-run consent gate. */
export function nextcloudAccessPrompt(toolNames: Iterable<string>): string {
  const names = [...toolNames];
  if (!names.length) return "";

  return (
    `\n\nA NAS/Nextcloud connector is configured, but the user did not explicitly name it in ` +
    `this turn. These tools are available as consent-gated entry points: ${names.join(", ")}. ` +
    `When a request to find, list, or read a file or folder may refer to the NAS and the local ` +
    `workspace does not satisfy it, call the matching NAS tool. The tool will ask the user for ` +
    `one-run permission before any remote access. Do not say the NAS is disconnected merely ` +
    `because "search_tools" does not list its other tools. Do not inspect cached files under ` +
    `".pixelspace/tool-output" or ".salur/tool-output" as a substitute for a fresh NAS call.`
  );
}
