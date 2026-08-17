import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ApprovedDatabaseTarget, DatabaseError, DatabaseResult } from "./database-adapter";

const DEFAULT_ALLOWED_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
];

// These remain blocked even if an operator later broadens the allowlist.
const DENIED_CIDRS = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fe80::/10",
  "ff00::/8",
];

const DENIED_ADDRESSES = new Set([
  "169.254.169.254", // AWS/Azure/GCP metadata
  "100.100.100.200", // Alibaba metadata
  "fd00:ec2::254", // AWS IPv6 metadata
]);

export type DatabaseNetworkPolicyOptions = {
  allowedCidrs?: string[];
  lookup?: typeof dnsLookup;
};

type ParsedCidr = { family: 4 | 6; network: bigint; bits: number; prefix: number };

function ipToBigInt(address: string): { family: 4 | 6; value: bigint; bits: number } | null {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const value = parts.reduce((out, part) => (out << 8n) | BigInt(part), 0n);
    return { family: 4, value, bits: 32 };
  }
  if (family !== 6) return null;

  // Normalize an IPv4 tail before expanding :: compression.
  let source = address.toLowerCase();
  const lastColon = source.lastIndexOf(":");
  const tail = source.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipToBigInt(tail);
    if (!v4) return null;
    const hi = Number((v4.value >> 16n) & 0xffffn).toString(16);
    const lo = Number(v4.value & 0xffffn).toString(16);
    source = `${source.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const sides = source.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sides.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return { family: 6, value, bits: 128 };
}

function parseCidr(raw: string): ParsedCidr {
  const [address, prefixText] = raw.trim().split("/");
  const parsed = ipToBigInt(address ?? "");
  const prefix = Number(prefixText);
  if (!parsed || !Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) {
    throw new Error(`Invalid database network CIDR: ${raw}`);
  }
  const shift = BigInt(parsed.bits - prefix);
  return {
    family: parsed.family,
    network: (parsed.value >> shift) << shift,
    bits: parsed.bits,
    prefix,
  };
}

function contains(cidr: ParsedCidr, address: string): boolean {
  const parsed = ipToBigInt(address);
  if (!parsed || parsed.family !== cidr.family) return false;
  const shift = BigInt(cidr.bits - cidr.prefix);
  return ((parsed.value >> shift) << shift) === cidr.network;
}

function policyAddress(address: string): string {
  const parsed = ipToBigInt(address);
  if (!parsed || parsed.family !== 6) return address.toLowerCase();
  // IPv4-mapped IPv6 must inherit the IPv4 policy. Otherwise
  // ::ffff:127.0.0.1 could bypass the loopback deny when IPv6 is broadly
  // allowlisted in a future environment.
  if ((parsed.value >> 32n) === 0xffffn) {
    const value = Number(parsed.value & 0xffffffffn);
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
  }
  return address.toLowerCase();
}

const invalidTarget = (message: string, field = "host"): DatabaseResult<never> => ({
  ok: false,
  error: { code: "target_not_allowed", message, field },
});

/**
 * Resolves and pins a database target before a driver sees it.
 *
 * Every DNS answer must pass policy, not merely the first one. The returned
 * literal address is what the adapter connects to, closing the validation /
 * second-resolution gap used by DNS-rebinding attacks.
 */
export class DatabaseNetworkPolicy {
  private readonly allowed: ParsedCidr[];
  private readonly denied = DENIED_CIDRS.map(parseCidr);
  private readonly lookupImpl: typeof dnsLookup;

  constructor(options: DatabaseNetworkPolicyOptions = {}) {
    this.allowed = (options.allowedCidrs ?? DEFAULT_ALLOWED_CIDRS).map(parseCidr);
    this.lookupImpl = options.lookup ?? dnsLookup;
  }

  async approve(hostInput: string): Promise<DatabaseResult<ApprovedDatabaseTarget>> {
    const host = hostInput.trim();
    if (!host) return invalidTarget("Host is required");
    if (
      host.includes("/") ||
      host.includes("\\") ||
      host.includes("://") ||
      host.startsWith(".") ||
      host.includes("%") ||
      /[\s@?#]/.test(host)
    ) {
      return invalidTarget("Host must be a DNS name or IP address, not a URL or socket path");
    }
    if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost")) {
      return invalidTarget("Loopback database targets are not allowed");
    }

    let addresses: { address: string; family: number }[];
    const literalFamily = isIP(host);
    if (literalFamily) {
      addresses = [{ address: host, family: literalFamily }];
    } else {
      try {
        addresses = await this.lookupImpl(host, { all: true, verbatim: true });
      } catch {
        const error: DatabaseError = {
          code: "dns_resolution_failed",
          message: "Database host could not be resolved",
          field: "host",
          retryable: true,
        };
        return { ok: false, error };
      }
    }

    if (!addresses.length) {
      return {
        ok: false,
        error: {
          code: "dns_resolution_failed",
          message: "Database host resolved to no addresses",
          field: "host",
          retryable: true,
        },
      };
    }

    for (const answer of addresses) {
      const normalized = policyAddress(answer.address);
      if (
        DENIED_ADDRESSES.has(normalized) ||
        this.denied.some((cidr) => contains(cidr, normalized)) ||
        !this.allowed.some((cidr) => contains(cidr, normalized))
      ) {
        return invalidTarget("Database host resolves outside the approved internal network");
      }
    }

    const selected = [...addresses].sort((a, b) => a.address.localeCompare(b.address))[0]!;
    return {
      ok: true,
      value: {
        originalHost: host,
        address: selected.address,
        family: selected.family as 4 | 6,
      },
    };
  }
}

export const DEFAULT_DATABASE_ALLOWED_CIDRS = [...DEFAULT_ALLOWED_CIDRS];
