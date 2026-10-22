// Shared by the core, the MCP adapter and the REST adapter: the error type, the
// request context, input validators and date helpers.

import type { Sql } from "../_shared/db.ts";

export const VERSION = "0.1.0";
export const DEFAULT_TZ = "Europe/Madrid";

export type Obj = Record<string, unknown>;

/** A failure the caller can act on. `status` is the HTTP status on REST; MCP returns it as a tool error. */
export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly detail: string) {
    super(detail);
    this.name = "AppError";
  }
}
export const bad = (detail: string) => new AppError(400, "invalid", detail);
export const notFound = (detail: string) => new AppError(404, "not_found", detail);
export const forbidden = (detail: string) => new AppError(403, "forbidden", detail);

/** Who is calling and how. Every core function takes one and filters by `userId`. */
export interface Ctx {
  sql: Sql;
  userId: string;
  /** How the caller authenticated: "pat:<token id>", "jwt" or "oauth:<client id>". */
  auth: string;
  /** Written to sawk.feedback.via: "web", "loco" or "mcp:<client>". */
  client: string;
  now: () => Date;
}

// MARK: - validators (input is `unknown`: REST bodies and MCP arguments both arrive here)

export function obj(v: unknown, what = "body"): Obj {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw bad(`${what} must be a JSON object`);
  return v as Obj;
}

export function optStr(o: Obj, k: string, max: number): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(`${k} must be a string`);
  const s = v.trim();
  if (s.length > max) throw bad(`${k} is longer than ${max} characters`);
  return s === "" ? undefined : s;
}

export function reqStr(o: Obj, k: string, max: number): string {
  const s = optStr(o, k, max);
  if (s === undefined) throw bad(`${k} is required`);
  return s;
}

export function optInt(o: Obj, k: string, min: number, max: number): number | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw bad(`${k} must be an integer from ${min} to ${max}`);
  }
  return n;
}

export function optNum(o: Obj, k: string, min: number, max: number): number | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw bad(`${k} must be a number from ${min} to ${max}`);
  }
  return n;
}

export function optEnum<T extends string>(o: Obj, k: string, allowed: readonly T[]): T | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw bad(`${k} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

export function reqEnum<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = optEnum(o, k, allowed);
  if (v === undefined) throw bad(`${k} is required (one of: ${allowed.join(", ")})`);
  return v;
}

export function optYmd(o: Obj, k: string): string | undefined {
  const v = optStr(o, k, 10);
  if (v === undefined) return undefined;
  if (!isYmd(v)) throw bad(`${k} must be a date as YYYY-MM-DD`);
  return v;
}

export function reqYmd(o: Obj, k: string): string {
  const v = optYmd(o, k);
  if (v === undefined) throw bad(`${k} is required (YYYY-MM-DD)`);
  return v;
}

export function optCountry(o: Obj, k: string): string | undefined {
  const v = optStr(o, k, 2);
  if (v === undefined) return undefined;
  if (!/^[A-Za-z]{2}$/.test(v)) throw bad(`${k} must be an ISO 3166-1 alpha-2 code like "ES"`);
  return v.toUpperCase();
}

export function optTz(o: Obj, k: string): string | undefined {
  const v = optStr(o, k, 64);
  if (v === undefined) return undefined;
  if (!validTz(v)) throw bad(`${k} must be an IANA time zone like "Europe/Madrid"`);
  return v;
}

/** A list of short strings: trimmed, empty ones dropped, duplicates removed (case-insensitive). */
export function strList(v: unknown, k: string, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) throw bad(`${k} must be an array of strings`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") throw bad(`${k} must contain only strings`);
    const s = x.trim();
    if (s === "") continue;
    if (s.length > maxLen) throw bad(`${k}: "${s.slice(0, 20)}…" is longer than ${maxLen} characters`);
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  if (out.length > maxItems) throw bad(`${k} has more than ${maxItems} items`);
  return out;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reqUuid(o: Obj, k: string): string {
  const v = reqStr(o, k, 36);
  if (!UUID.test(v)) throw bad(`${k} must be an id as returned by the server`);
  return v.toLowerCase();
}

/** An http(s) URL, normalised. */
export function httpUrl(v: unknown, what: string, max = 2000): string {
  if (typeof v !== "string" || v.trim() === "") throw bad(`${what} is required`);
  const s = v.trim();
  if (s.length > max) throw bad(`${what} is longer than ${max} characters`);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${what} is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad(`${what} must start with http:// or https://`);
  return u.toString();
}

/** A URL the server may later fetch (a source): public hosts only, no loopback, link-local or private ranges. */
export function publicHttpUrl(v: unknown, what: string): string {
  const s = httpUrl(v, what);
  const host = new URL(s).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateV4 =
    /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    privateV4.test(host) || host.includes(":") || !host.includes(".")
  ) throw bad(`${what} must be a public web address`);
  return s;
}

// MARK: - dates

export function isYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date at `now` in `tz`. */
export function todayIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: validTz(tz) ? tz : DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// MARK: - rows

export const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString();
export const ymdOf = (v: unknown): string => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
export const num = (v: unknown): number | null => v == null ? null : Number(v);

/** Drops null and undefined keys, recursively: agents pay for every token. */
export function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact) as T;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v as Obj)) if (x !== null && x !== undefined) out[k] = compact(x);
    return out as T;
  }
  return v;
}
