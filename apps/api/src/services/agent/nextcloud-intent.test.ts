import { describe, expect, it } from "bun:test";
import {
  currentUserRequest,
  explicitlyRequestsNextcloud,
  referencesNextcloud,
} from "./nextcloud-intent";

describe("explicitlyRequestsNextcloud", () => {
  it.each([
    "Find the audited accounts in Nextcloud",
    "search NAS for last month's invoices",
    "what files are on the NAS?",
    "upload this report to my Nextcloud",
    "use Nextcloud",
    "show me the Nextcloud documents",
    "tolong cari fail dalam NAS",
    "semak Nextcloud untuk invois",
    "muat naik ini ke Nextcloud",
  ])("allows an explicit storage request: %s", (request) => {
    expect(explicitlyRequestsNextcloud(request)).toBe(true);
  });

  it.each([
    "find the audited accounts",
    "list files on this server",
    "do not use Nextcloud; search the workspace",
    "please avoid the NAS",
    "why did you search the NAS?",
    "explain what Nextcloud is",
    "Nextcloud is slow today",
    "how do I use Nextcloud?",
    "explain how to search the NAS",
    "cara guna Nextcloud",
    "apa itu Nextcloud?",
    "jangan guna Nextcloud",
    "tak mahu NAS",
    "kenapa awak cari NAS?",
    "why is Nextcloud slow?",
  ])("does not infer storage permission: %s", (request) => {
    expect(explicitlyRequestsNextcloud(request)).toBe(false);
  });

  it("uses only the current user turn, not an older authorisation", () => {
    const request = currentUserRequest([
      { role: "user", content: "Search Nextcloud for the budget" },
      { role: "assistant", content: "I found it." },
      { role: "user", content: "Now list files on this server" },
    ]);
    expect(request).toBe("Now list files on this server");
    expect(explicitlyRequestsNextcloud(request)).toBe(false);
  });

  it("recognises learned tool routes even when they omit the product name", () => {
    expect(referencesNextcloud("Use nextcloud__nc_webdav_find_by_name for files")).toBe(true);
    expect(referencesNextcloud("Call nc_notes_search_notes before answering")).toBe(true);
    expect(referencesNextcloud("Use search_docs for uploaded PDFs")).toBe(false);
  });
});
