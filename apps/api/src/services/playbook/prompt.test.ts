import { describe, expect, it } from "bun:test";
import { renderForReflector, renderPlaybook, selectForPrompt } from "./prompt";
import type { Bullet } from "./types";

const bullet = (over: Partial<Bullet> = {}): Bullet => ({
  id: "pb_1",
  kind: "fact",
  content: "The Plane workspace is at https://plane.example/hq",
  helpful: 0,
  harmful: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

describe("selectForPrompt", () => {
  it("excludes a demoted bullet", () => {
    const kept = selectForPrompt([bullet({ id: "pb_bad", harmful: 3 }), bullet({ id: "pb_ok" })]);
    expect(kept.map((b) => b.id)).toEqual(["pb_ok"]);
  });

  it("ranks by net value, then recency", () => {
    const kept = selectForPrompt([
      bullet({ id: "old", helpful: 1, updatedAt: 1 }),
      bullet({ id: "best", helpful: 9, content: "b" }),
      bullet({ id: "new", helpful: 1, updatedAt: 99, content: "c" }),
    ]);
    expect(kept.map((b) => b.id)).toEqual(["best", "new", "old"]);
  });

  it("drops the lowest-scoring bullets when over the cap", () => {
    const bullets = Array.from({ length: 10 }, (_, i) =>
      bullet({ id: `pb_${i}`, helpful: i, content: `${i} `.repeat(20) }),
    );
    const kept = selectForPrompt(bullets, 200);
    expect(kept.length).toBeLessThan(10);
    // The survivors are the high scorers, not the first ones seen.
    expect(kept[0]!.id).toBe("pb_9");
  });

  it("keeps filling the budget with a short bullet after skipping a long one", () => {
    // `continue`, not `break`: a single long bullet must not shut out every
    // shorter one behind it.
    const kept = selectForPrompt(
      [
        bullet({ id: "long", helpful: 9, content: "x".repeat(120) }),
        bullet({ id: "short", helpful: 1, content: "y" }),
      ],
      50,
    );
    expect(kept.map((b) => b.id)).toEqual(["short"]);
  });
});

describe("renderPlaybook", () => {
  it("is empty for a workspace that has learned nothing", () => {
    // A heading promising knowledge that is not there invites the model to
    // supply some.
    expect(renderPlaybook([])).toBe("");
  });

  it("is empty when every bullet is demoted", () => {
    expect(renderPlaybook([bullet({ harmful: 4 })])).toBe("");
  });

  it("groups by kind under its own heading", () => {
    const text = renderPlaybook([
      bullet({ id: "f", kind: "fact", content: "Plane is at X" }),
      bullet({ id: "r", kind: "route", content: "Use plane__create_work_item" }),
      bullet({ id: "p", kind: "pitfall", content: "No slug tool exists" }),
    ]);

    expect(text).toContain("What you know about this workspace");
    expect(text).toContain("How to do things here");
    expect(text).toContain("Dead ends");
    expect(text.indexOf("Plane is at X")).toBeLessThan(text.indexOf("No slug tool exists"));
  });

  it("does not spend tokens on ids the model has no use for", () => {
    expect(renderPlaybook([bullet({ id: "pb_secret" })])).not.toContain("pb_secret");
  });
});

describe("renderForReflector", () => {
  it("includes ids and counters, because the reflector updates by reference", () => {
    const text = renderForReflector([bullet({ id: "pb_7", helpful: 2, harmful: 1 })]);
    expect(text).toContain("pb_7");
    expect(text).toContain("helpful 2");
    expect(text).toContain("harmful 1");
  });

  it("says the playbook is empty rather than returning nothing", () => {
    expect(renderForReflector([])).toContain("empty");
  });
});
