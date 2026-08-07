import { describe, expect, it } from "bun:test";
import { argNamesOf, buildIndex, coreToolNames, searchTools } from "./tool-search";

/**
 * Ranked against a slice of the real catalog this was built for — a Nextcloud
 * server advertising 151 tools. Invented tool names would rank cleanly and
 * prove nothing: the hard cases here are all real, like six tools whose names
 * share the `nc_webdav_` prefix and differ only in the verb.
 */
const CATALOG = [
  { name: "nextcloud__nc_webdav_list_directory", description: "List the contents of a directory", args: ["path"] },
  { name: "nextcloud__nc_webdav_read_file", description: "Read the contents of a file", args: ["path"] },
  { name: "nextcloud__nc_webdav_write_file", description: "Write content to a file", args: ["path", "content"] },
  { name: "nextcloud__nc_webdav_find_by_name", description: "Find files by name pattern", args: ["pattern"] },
  { name: "nextcloud__nc_webdav_create_directory", description: "Create a new directory", args: ["path"] },
  { name: "nextcloud__nc_notes_search_notes", description: "Search notes by their content", args: ["query"] },
  { name: "nextcloud__nc_calendar_list_calendars", description: "List the user's calendars", args: [] },
  { name: "nextcloud__nc_calendar_get_upcoming_events", description: "Upcoming events across calendars", args: ["days"] },
  { name: "nextcloud__nc_mail_list_accounts", description: "List configured mail accounts", args: [] },
  { name: "nextcloud__nc_share_create_public_link", description: "Create a public share link for a file", args: ["path"] },
  { name: "nextcloud__nc_tables_list_tables", description: "List the tables the user can access", args: [] },
  { name: "nextcloud__talk_list_conversations", description: "List Talk conversations", args: [] },
];

const index = buildIndex(CATALOG);
const top = (query: string) => searchTools(index, query, 5).map((m) => m.name);

describe("searchTools", () => {
  it("finds a tool from a description of the task, not its name", () => {
    // The model writes what it wants to do; nothing here says "webdav".
    expect(top("read the contents of a file")).toContain("nextcloud__nc_webdav_read_file");
  });

  it("separates tools whose names differ only by verb", () => {
    // Five `nc_webdav_*` tools share almost every term. The verb has to win.
    expect(top("create a new folder")[0]).toBe("nextcloud__nc_webdav_create_directory");
    expect(top("search for a file by its name")[0]).toBe("nextcloud__nc_webdav_find_by_name");
  });

  it("ranks by subsystem when the query names one", () => {
    const calendar = top("upcoming calendar events");
    expect(calendar[0]).toBe("nextcloud__nc_calendar_get_upcoming_events");
  });

  it("matches an argument name no description mentions", () => {
    // "pattern" appears only as a parameter, which is exactly the case that
    // motivated indexing argument names at all.
    expect(top("match files against a pattern")).toContain("nextcloud__nc_webdav_find_by_name");
  });

  it("falls back to substrings so a partial word still finds something", () => {
    // BM25 scores whole terms, so "calend" matches no term at all. Returning
    // nothing invites the model to answer from memory instead of looking again.
    const hits = top("calend");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.includes("calendar"))).toBe(true);
  });

  it("never lets a substring rescue outrank a real match", () => {
    // "notes" is a genuine term hit for the notes tool and a substring of
    // nothing else that should beat it.
    expect(top("search my notes")[0]).toBe("nextcloud__nc_notes_search_notes");
  });

  it("respects the result limit", () => {
    expect(searchTools(index, "list", 3)).toHaveLength(3);
  });

  it("returns nothing for an empty query rather than everything", () => {
    expect(searchTools(index, "   ", 5)).toEqual([]);
    expect(searchTools(index, "the and of", 5)).toEqual([]);
  });

  it("handles an empty catalog without dividing by zero", () => {
    expect(searchTools(buildIndex([]), "anything", 5)).toEqual([]);
  });
});

describe("coreToolNames", () => {
  const available = new Set(CATALOG.map((c) => c.name));

  it("takes the most-called tools, most-used first", () => {
    const core = coreToolNames(
      [
        { name: "nextcloud__nc_webdav_read_file", calls: 7 },
        { name: "nextcloud__nc_webdav_list_directory", calls: 44 },
        { name: "nextcloud__nc_notes_search_notes", calls: 15 },
      ],
      available,
      2,
    );
    expect(core).toEqual([
      "nextcloud__nc_webdav_list_directory",
      "nextcloud__nc_notes_search_notes",
    ]);
  });

  it("drops a tool the catalog no longer advertises", () => {
    // pi throws on an unknown name in setActiveTools, so a stale trace reaching
    // the active set would fail the run at construction rather than degrade.
    const core = coreToolNames(
      [
        { name: "nextcloud__nc_removed_tool", calls: 99 },
        { name: "nextcloud__nc_webdav_read_file", calls: 1 },
      ],
      available,
      5,
    );
    expect(core).toEqual(["nextcloud__nc_webdav_read_file"]);
  });

  it("returns nothing for a workspace with no history", () => {
    expect(coreToolNames([], available, 15)).toEqual([]);
  });

  it("treats a zero limit as disabling the core set", () => {
    expect(coreToolNames([{ name: "nextcloud__nc_webdav_read_file", calls: 5 }], available, 0)).toEqual([]);
  });

  it("breaks a tie by name so the active set is stable across runs", () => {
    // An unstable core set would reshuffle the tool list every run and defeat
    // whatever prompt caching the gateway manages.
    const usage = [
      { name: "nextcloud__nc_webdav_read_file", calls: 3 },
      { name: "nextcloud__nc_mail_list_accounts", calls: 3 },
    ];
    expect(coreToolNames(usage, available, 1)).toEqual(coreToolNames([...usage].reverse(), available, 1));
  });
});

describe("argNamesOf", () => {
  it("reads property names from a stored input schema", () => {
    expect(argNamesOf('{"type":"object","properties":{"path":{"type":"string"},"depth":{}}}')).toEqual([
      "path",
      "depth",
    ]);
  });

  it("returns nothing for absent, malformed, or property-less schemas", () => {
    expect(argNamesOf(null)).toEqual([]);
    expect(argNamesOf("not json")).toEqual([]);
    expect(argNamesOf('{"type":"object"}')).toEqual([]);
  });
});
