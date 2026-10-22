// POST/GET /functions/v1/sawk/… — SAWk's one edge function.
//
//   /mcp                                        Streamable HTTP MCP, stateless: a fresh server per request
//   /api/*                                      REST for the web feed and Loco (docs/ARCHITECTURE.md)
//   /.well-known/oauth-protected-resource       RFC 9728: where an MCP client signs in
//
// Deploy with --no-verify-jwt: the platform gate would answer a browser's CORS
// preflight and a bare 401 without the header an MCP client needs. Auth is
// auth.ts, on every route but /api/health and the metadata.
// `index.ts` only serves this; kept apart so tests can call `handle`.

import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.30.0/server/webStandardStreamableHttp.js";
import type { JWTVerifyGetKey } from "npm:jose@6.1.0";
import { db, type Sql } from "../_shared/db.ts";
import { authenticate, type Caller, issuerOf, Unauthorized } from "./auth.ts";
import { buildServer } from "./mcp.ts";
import { health, MAX_BODY_BYTES, route } from "./rest.ts";
import { AppError, type Ctx } from "./util.ts";

/** Browsers allowed to call /api. Self-hosters add theirs in SAWK_ALLOWED_ORIGINS (comma-separated). */
export const DEFAULT_ORIGINS = ["https://zaitsew.github.io", "http://localhost:5173"];

export interface Deps {
  /** `https://<ref>.supabase.co` */
  supabaseUrl: string;
  sql: () => Sql;
  /** The project's signing keys; tests pass a local set. */
  keys?: JWTVerifyGetKey;
  now: () => number;
  log: (line: Record<string, unknown>) => void;
  origins: string[];
}

export function defaultDeps(): Deps {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) throw new Error("SUPABASE_URL is not set");
  const extra = (Deno.env.get("SAWK_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    sql: db,
    now: () => Date.now(),
    log: (line) => console.log(JSON.stringify(line)),
    origins: [...DEFAULT_ORIGINS, ...extra],
  };
}

/** The path below the function: `/functions/v1/sawk/api/feed` and `/sawk/api/feed` are both `/api/feed`. */
export function subpath(url: string): string {
  const parts = new URL(url).pathname.split("/");
  const at = parts.indexOf("sawk");
  const rest = at < 0 ? [] : parts.slice(at + 1);
  return "/" + rest.filter((p) => p !== "").join("/");
}

/** `https://<ref>.supabase.co/functions/v1/sawk`, whatever host the request reached us by. */
export const baseOf = (supabaseUrl: string) => `${supabaseUrl.replace(/\/$/, "")}/functions/v1/sawk`;

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

function challenge(supabaseUrl: string, invalid: boolean): string {
  return `Bearer resource_metadata="${baseOf(supabaseUrl)}${WELL_KNOWN}"${invalid ? `, error="invalid_token"` : ""}`;
}

const OPEN_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, retry-after",
  "access-control-max-age": "86400",
};

function corsFor(req: Request, path: string, deps: Deps): Record<string, string> {
  if (!path.startsWith("/api/")) return OPEN_CORS;
  const origin = req.headers.get("origin");
  const base: Record<string, string> = {
    vary: "origin",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-sawk-client",
    "access-control-expose-headers": "www-authenticate",
    "access-control-max-age": "86400",
  };
  // Health is public and harmless to read from anywhere; everything else only from the listed origins.
  if (path === "/api/health") return { ...base, "access-control-allow-origin": "*" };
  return origin && deps.origins.includes(origin) ? { ...base, "access-control-allow-origin": origin } : base;
}

function json(
  body: unknown,
  status: number,
  cors: Record<string, string>,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

const errorBody = (e: AppError) => ({ error: e.code, detail: e.detail });

/** What goes into sawk.feedback.via for a call: the MCP client, or web/loco from the REST header. */
function clientOf(req: Request, path: string, caller: Caller): string {
  if (path === "/mcp") {
    const [kind, id] = [caller.via.split(":")[0], caller.via.slice(caller.via.indexOf(":") + 1)];
    return `mcp:${kind === "pat" ? "pat" : kind === "oauth" ? id.slice(0, 40) : "jwt"}`;
  }
  const h = (req.headers.get("x-sawk-client") ?? "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,24}$/.test(h) ? h : "web";
}

export async function handle(req: Request, deps: Deps = defaultDeps()): Promise<Response> {
  const path = subpath(req.url);
  const cors = corsFor(req, path, deps);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (path === "/api/health") {
    return req.method === "GET"
      ? json(health(), 200, cors)
      : json({ error: "method_not_allowed" }, 405, cors, { allow: "GET, OPTIONS" });
  }

  if (path === WELL_KNOWN || path === `${WELL_KNOWN}/mcp`) {
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors, { allow: "GET, OPTIONS" });
    return json(
      {
        resource: `${baseOf(deps.supabaseUrl)}/mcp`,
        authorization_servers: [issuerOf(deps.supabaseUrl)],
        bearer_methods_supported: ["header"],
      },
      200,
      cors,
      { "cache-control": "public, max-age=3600" },
    );
  }

  if (path !== "/mcp" && !path.startsWith("/api/")) {
    return json({ error: "not_found", detail: "no such route" }, 404, cors);
  }

  // /mcp is stateless: nothing to stream to a GET, no session to DELETE.
  if (path === "/mcp" && req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, cors, { allow: "POST, OPTIONS" });
  }

  let caller: Caller;
  try {
    caller = await authenticate(req, { supabaseUrl: deps.supabaseUrl, sql: deps.sql, keys: deps.keys, now: deps.now });
  } catch (e) {
    if (!(e instanceof Unauthorized)) throw e;
    deps.log({ ev: "auth", outcome: e.reason, detail: e.reason === "invalid" ? e.message : undefined });
    return json(
      {
        error: "unauthorized",
        detail: e.reason === "missing" ? "send Authorization: Bearer <token>" : "the token is not valid",
      },
      401,
      cors,
      { "www-authenticate": challenge(deps.supabaseUrl, e.reason === "invalid") },
    );
  }

  const ctx: Ctx = {
    sql: deps.sql(),
    userId: caller.userId,
    auth: caller.via,
    client: clientOf(req, path, caller),
    now: () => new Date(deps.now()),
  };

  if (path === "/mcp") return await mcp(req, ctx, deps, cors);

  try {
    return json(await route(req, path, ctx), 200, cors);
  } catch (e) {
    if (e instanceof AppError) {
      return json(errorBody(e), e.status, cors, e.status === 405 ? { allow: e.detail.replace(/^use /, "") } : {});
    }
    // The message of an internal error can carry data; log the kind only.
    deps.log({ ev: "error", path, name: e instanceof Error ? e.name : "unknown" });
    return json({ error: "internal", detail: "something went wrong on the server" }, 500, cors);
  }
}

async function mcp(req: Request, ctx: Ctx, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ error: "too_large", detail: "request body is too large" }, 413, cors);
  const server = buildServer(ctx, { tool: (e) => deps.log({ ev: "tool", ...e }) });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  } finally {
    // The answer is already built (JSON mode); the server and transport go with the request.
    queueMicrotask(() => {
      server.close().catch(() => {});
    });
  }
}
