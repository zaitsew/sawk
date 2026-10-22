// Test helpers shared by the *_test.ts files: an in-memory database, a fake
// JWKS, tokens, and callers for the core, REST and MCP.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "npm:jose@6.1.0";
import { testDb } from "../_shared/testdb.ts";
import { newTokenText, sha256Hex } from "./auth.ts";
import { type Deps, handle } from "./handler.ts";
import type { Ctx } from "./util.ts";

export const SUPABASE_URL = "https://example-project.supabase.co";
export const FN = `${SUPABASE_URL}/functions/v1/sawk`;
export const ISS = `${SUPABASE_URL}/auth/v1`;
export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";

const pair = await generateKeyPair("ES256", { extractable: true });
const otherPair = await generateKeyPair("ES256", { extractable: true });
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
export const keys = createLocalJWKSet({ keys: [jwk] });

export async function jwt(
  userId = USER_A,
  claims: Record<string, unknown> = {},
  o: { other?: boolean; iss?: string; expIn?: number } = {},
) {
  return await new SignJWT({ role: "authenticated", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject(userId)
    .setIssuer(o.iss ?? ISS)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (o.expIn ?? 3600))
    .sign(o.other ? otherPair.privateKey : pair.privateKey);
}

/** An HS256 token with a shared secret: what the project's anon and service-role keys are. */
export async function legacyKey(role: string) {
  return await new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("supabase")
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode("a-shared-secret-of-at-least-32-bytes!!"));
}

export async function setup() {
  const t = await testDb();
  const lines: Record<string, unknown>[] = [];
  const deps: Deps = {
    supabaseUrl: SUPABASE_URL,
    sql: () => t.sql,
    keys,
    now: () => Date.now(),
    log: (l) => lines.push(l),
    origins: ["https://zaitsew.github.io", "http://localhost:5173"],
  };
  const ctx = (userId = USER_A, over: Partial<Ctx> = {}): Ctx => ({
    sql: t.sql,
    userId,
    auth: "jwt",
    client: "web",
    now: () => new Date(),
    ...over,
  });
  /** A personal access token for `userId`, stored the way the server stores it. */
  async function pat(userId = USER_A, name = "test") {
    const token = newTokenText();
    const rows = await t.sql<{ id: string }>`
      insert into sawk.tokens (user_id, name, hash, prefix) values (${userId}::uuid, ${name}, ${await sha256Hex(
      token,
    )}, ${token.slice(0, 12)}) returning id`;
    return { token, id: rows[0].id };
  }
  async function http(
    method: string,
    path: string,
    o: { bearer?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const res = await handle(
      new Request(`${FN}${path}`, {
        method,
        headers: {
          ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          ...o.headers,
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      }),
      deps,
    );
    const raw = await res.text();
    return { status: res.status, headers: res.headers, json: raw ? JSON.parse(raw) : null };
  }
  let rpcId = 0;
  async function rpc(bearer: string, method: string, params: Record<string, unknown> = {}) {
    const res = await handle(
      new Request(`${FN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      }),
      deps,
    );
    return { status: res.status, json: await res.json() as { result?: any; error?: any } };
  }
  /** Calls an MCP tool and returns its parsed JSON, or `{error}` text when the tool reported an error. */
  async function tool(bearer: string, name: string, args: Record<string, unknown> = {}) {
    const r = await rpc(bearer, "tools/call", { name, arguments: args });
    if (r.json.error) return { isError: true, text: String(r.json.error.message), data: null as any };
    const text = r.json.result.content[0].text as string;
    return {
      isError: r.json.result.isError === true,
      text,
      data: r.json.result.isError ? null : JSON.parse(text) as any,
    };
  }
  return { ...t, deps, lines, ctx, pat, http, rpc, tool };
}

/** An ISO time `hours` from now, with the +02:00 offset the examples use. */
export function inHours(hours: number, offset = "+02:00"): string {
  const d = new Date(Date.now() + hours * 3_600_000 + 2 * 3_600_000);
  return d.toISOString().replace("Z", "").replace(/\.\d+$/, "") + offset;
}

export const ymd = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

export function ev(title: string, over: Record<string, unknown> = {}) {
  return {
    title,
    startsAt: inHours(30),
    city: "Valencia",
    country: "ES",
    tz: "Europe/Madrid",
    venue: "Jimmy Glass",
    category: "music",
    url: "https://example.org/e/" + encodeURIComponent(title),
    ...over,
  };
}
