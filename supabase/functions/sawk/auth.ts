// Who is calling: the bearer token, verified here.
//
//  - `sawk_pat_<32 base62>`: a personal access token for headless runs, looked
//    up by SHA-256 in sawk.tokens (revoked ones fail).
//  - otherwise a Supabase JWT of the project: a session, or the token the
//    project's OAuth 2.1 server issues to an agent after consent. Verified
//    against the project's JWKS (asymmetric keys only: the anon and service-role
//    keys are HS256 and never verify), issuer, expiry and `role: authenticated`.
//    Same checks as Loco's loco-mcp/auth.ts.

import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify, type JWTVerifyGetKey } from "npm:jose@6.1.0";
import type { Sql } from "../_shared/db.ts";

export interface Caller {
  userId: string;
  /** "pat:<token id>" | "jwt" | "oauth:<client id>" */
  via: string;
}

export class Unauthorized extends Error {
  constructor(public readonly reason: "missing" | "invalid", detail = "") {
    super(detail || reason);
    this.name = "Unauthorized";
  }
}

export interface AuthConfig {
  /** `https://<ref>.supabase.co` */
  supabaseUrl: string;
  sql: () => Sql;
  /** Replaces the project's JWKS: tests only. */
  keys?: JWTVerifyGetKey;
  /** The clock `exp` and `last_used_at` are judged by, in ms. */
  now?: () => number;
}

export const issuerOf = (supabaseUrl: string) => `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;

export const PAT_PREFIX = "sawk_pat_";
const PAT_RE = /^sawk_pat_[0-9A-Za-z]{32}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sawk_pat_` + 32 base62 characters, uniformly drawn. */
export function newTokenText(): string {
  let out = "";
  while (out.length < 32) {
    for (const b of crypto.getRandomValues(new Uint8Array(48))) {
      if (b < 248 && out.length < 32) out += BASE62[b % 62]; // 248 = 4 * 62: no modulo bias
    }
  }
  return PAT_PREFIX + out;
}

let remote: { url: string; keys: JWTVerifyGetKey } | undefined;

function keysFor(cfg: AuthConfig): JWTVerifyGetKey {
  if (cfg.keys) return cfg.keys;
  const url = `${issuerOf(cfg.supabaseUrl)}/.well-known/jwks.json`;
  if (remote?.url !== url) {
    // Cached by the isolate; a key rotation is picked up when an unknown `kid` shows up.
    remote = { url, keys: createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 600_000 }) };
  }
  return remote.keys;
}

/** The token in `Authorization: Bearer …`, or `missing`. */
export function bearerOf(req: Request): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  if (!m) throw new Unauthorized("missing");
  return m[1];
}

export async function authenticate(req: Request, cfg: AuthConfig): Promise<Caller> {
  const token = bearerOf(req);
  if (token.startsWith(PAT_PREFIX)) return await authenticatePat(token, cfg);
  return await authenticateJwt(token, cfg);
}

async function authenticatePat(token: string, cfg: AuthConfig): Promise<Caller> {
  if (!PAT_RE.test(token)) throw new Unauthorized("invalid", "token_format");
  const sql = cfg.sql();
  const hash = await sha256Hex(token);
  const rows = await sql<{ id: string; user_id: string; last_used_at: Date | null }>`
    select id, user_id, last_used_at from sawk.tokens where hash = ${hash} and revoked_at is null`;
  const row = rows[0];
  if (!row) throw new Unauthorized("invalid", "unknown_or_revoked_token");
  const now = new Date(cfg.now ? cfg.now() : Date.now());
  // Touch at most once a minute: a busy agent should not rewrite the row on every call.
  if (!row.last_used_at || now.getTime() - new Date(row.last_used_at).getTime() >= 60_000) {
    await sql`update sawk.tokens set last_used_at = ${now.toISOString()}::timestamptz where id = ${row.id}::uuid`;
  }
  return { userId: String(row.user_id), via: `pat:${row.id}` };
}

async function authenticateJwt(token: string, cfg: AuthConfig): Promise<Caller> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keysFor(cfg), {
      issuer: issuerOf(cfg.supabaseUrl),
      // Asymmetric only: the anon and service keys are HS256 and must never verify here.
      algorithms: ["ES256", "RS256", "EdDSA"],
      clockTolerance: 5,
      currentDate: cfg.now ? new Date(cfg.now()) : undefined,
    }));
  } catch (e) {
    if (e instanceof errors.JOSEError) throw new Unauthorized("invalid", e.code);
    throw new Unauthorized("invalid", "verification_failed");
  }
  if (payload.role !== "authenticated") throw new Unauthorized("invalid", "role");
  if (typeof payload.sub !== "string" || payload.sub === "") throw new Unauthorized("invalid", "sub");
  if (typeof payload.exp !== "number") throw new Unauthorized("invalid", "exp");
  const clientId = typeof payload.client_id === "string" && payload.client_id !== "" ? payload.client_id : null;
  return { userId: payload.sub, via: clientId ? `oauth:${clientId}` : "jwt" };
}
