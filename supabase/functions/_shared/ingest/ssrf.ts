// A fetch that refuses to leave the public internet. Source URLs are rows in a
// shared table that people and agents add to, so the daily ingest must not be
// steerable at the database host, a metadata service or a private network.
//
// Checks, on the first URL and on every redirect hop (followed by hand):
//   - http or https only, no credentials in the URL
//   - no localhost, single-label or internal host names
//   - no IP literal in a private, loopback, link-local, multicast or reserved range
//   - every address the name resolves to is public (when the runtime can resolve names)
// Known gap: the name is resolved here and again by fetch, so a DNS server that
// answers differently the second time (rebinding) is not stopped by this alone.
// The ingest only reads, never forwards a body, and sends no credentials.

import type { Fetch } from "./types.ts";

export type Resolver = (host: string) => Promise<string[]>;

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPrivateV4(ip: string): boolean {
  const m = V4.exec(ip);
  if (!m) return true;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if ([a, b, c, Number(m[4])].some((n) => n > 255)) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

export function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (s === "::" || s === "::1") return true;
  const mapped = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return isPrivateV4(mapped[1]);
  // ::ffff:7f00:1 (hex form of a mapped address)
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isPrivateV4(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  const first = parseInt(s.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 || // multicast
    s.startsWith("2001:db8:") || s.startsWith("2001:0db8:");
}

export function isPrivateIp(ip: string): boolean {
  return ip.includes(":") ? isPrivateV6(ip) : isPrivateV4(ip);
}

const isIpLiteral = (h: string) => V4.test(h) || h.includes(":");

/** null when the URL may be fetched, otherwise the reason it may not. */
export async function checkUrl(raw: string, resolve?: Resolver): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme ${u.protocol.replace(":", "")} is not allowed`;
  if (u.username || u.password) return "credentials in the URL are not allowed";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIpLiteral(host)) return isPrivateIp(host) ? "private address" : null;
  if (
    !host.includes(".") || host === "localhost" || /\.(localhost|local|internal|lan|home|intranet|corp)$/.test(host)
  ) {
    return "internal host name";
  }
  if (resolve) {
    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch (e) {
      return `cannot verify ${host}: ${(e as Error).message}`;
    }
    if (addrs.some(isPrivateIp)) return `${host} resolves to a private address`;
  }
  return null;
}

/** Resolves A and AAAA records. A name without records resolves to nothing, and the fetch then fails by itself. */
export const denoResolver: Resolver | undefined = typeof Deno?.resolveDns === "function"
  ? async (host) => {
    const out: string[] = [];
    for (const type of ["A", "AAAA"] as const) {
      try {
        out.push(...(await Deno.resolveDns(host, type)));
      } catch (e) {
        const name = (e as Error).name;
        if (name !== "NotFound" && !/no (data|record)|nxdomain|not found/i.test((e as Error).message)) throw e;
      }
    }
    return out;
  }
  : undefined;

export const MAX_REDIRECTS = 5;

/** Wraps a fetch: every hop is checked, redirects are followed here (at most 5) and never by the inner fetch. */
export function guardedFetch(inner: Fetch, resolve: Resolver | undefined = denoResolver): Fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const why = await checkUrl(url, resolve);
      if (why) throw new Error(`blocked ${new URL(url, "http://x").host || url}: ${why}`);
      const res = await inner(url, { ...init, redirect: "manual" });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel().catch(() => {});
        url = new URL(loc, url).href;
        continue;
      }
      return res;
    }
    throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
  }) as Fetch;
}
