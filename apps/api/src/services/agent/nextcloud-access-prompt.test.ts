import { describe, expect, it } from "bun:test";
import { nextcloudAccessPrompt } from "./nextcloud-access-prompt";

describe("nextcloudAccessPrompt", () => {
  it("explains the consent gate without claiming the connector is unavailable", () => {
    const prompt = nextcloudAccessPrompt([
      "nas__nc_webdav_find_by_name",
      "nas__nc_webdav_list_directory",
    ]);

    expect(prompt).toContain("consent-gated entry points");
    expect(prompt).toContain("nas__nc_webdav_find_by_name");
    expect(prompt).toContain("one-run permission");
    expect(prompt).toContain("Do not say the NAS is disconnected");
    expect(prompt).toContain(".pixelspace/tool-output");
  });

  it("adds nothing when no gated NAS tools are available", () => {
    expect(nextcloudAccessPrompt([])).toBe("");
  });
});
