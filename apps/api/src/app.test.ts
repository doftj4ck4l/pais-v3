import { describe, expect, it } from "bun:test";
import { createApp } from "./app";

/**
 * These assert the wiring, not the middleware itself: that tenant-scoped
 * routes are behind auth and that the one route the container healthcheck
 * calls is not.
 */
describe("api auth wiring", () => {
  it("refuses a tenant-scoped route with no identity", async () => {
    const res = await createApp().request("/api/workspaces");

    expect(res.status).toBe(401);
  });

  it("leaves /api/meta open for the container healthcheck", async () => {
    const res = await createApp().request("/api/meta");

    expect(res.status).toBe(200);
  });
});
