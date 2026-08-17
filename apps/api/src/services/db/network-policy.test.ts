import { describe, expect, it } from "bun:test";
import { DatabaseNetworkPolicy } from "./network-policy";

const lookup = (answers: { address: string; family: 4 | 6 }[]) =>
  (async () => answers) as any;

describe("DatabaseNetworkPolicy", () => {
  it("allows and pins an approved private address", async () => {
    const result = await new DatabaseNetworkPolicy().approve("10.35.180.238");
    expect(result).toEqual({
      ok: true,
      value: { originalHost: "10.35.180.238", address: "10.35.180.238", family: 4 },
    });
  });

  it("allows a hostname only when every DNS answer is approved", async () => {
    const policy = new DatabaseNetworkPolicy({
      lookup: lookup([
        { address: "10.35.180.239", family: 4 },
        { address: "10.35.180.238", family: 4 },
      ]),
    });
    const result = await policy.approve("warehouse.internal");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.address).toBe("10.35.180.238");
  });

  it("rejects a hostname with a mixed public/private answer set", async () => {
    const policy = new DatabaseNetworkPolicy({
      lookup: lookup([
        { address: "10.35.180.238", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ]),
    });
    const result = await policy.approve("rebinding.example");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("target_not_allowed");
  });

  for (const target of [
    "127.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    it(`rejects unsafe target ${target}`, async () => {
      const result = await new DatabaseNetworkPolicy({
        allowedCidrs: ["0.0.0.0/0", "::/0"],
      }).approve(target);
      expect(result.ok).toBe(false);
    });
  }

  it("rejects public addresses under the default internal-network policy", async () => {
    expect((await new DatabaseNetworkPolicy().approve("8.8.8.8")).ok).toBe(false);
  });

  for (const target of ["localhost", "/var/run/postgresql", "postgres://10.0.0.2/db", "a@10.0.0.2"] ) {
    it(`rejects non-host input ${target}`, async () => {
      expect((await new DatabaseNetworkPolicy().approve(target)).ok).toBe(false);
    });
  }

  it("reports DNS failures without echoing the target", async () => {
    const policy = new DatabaseNetworkPolicy({
      lookup: (async () => { throw new Error("lookup warehouse.secret.example failed"); }) as any,
    });
    const result = await policy.approve("warehouse.secret.example");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("warehouse.secret.example");
  });
});
