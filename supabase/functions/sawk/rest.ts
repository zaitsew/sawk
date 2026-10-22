// The REST adapter for the web feed and Loco: the same core functions as the
// MCP tools, over JSON.

import * as core from "./core.ts";
import { AppError, bad, type Ctx, notFound, VERSION } from "./util.ts";

export const MAX_BODY_BYTES = 1_000_000;

/** Query string to the loose object the core validates. */
function query(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

async function body(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new AppError(413, "too_large", "request body is too large");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw bad("body is not valid JSON");
  }
}

const methodNotAllowed = (allow: string) => new AppError(405, "method_not_allowed", `use ${allow}`);

/** `path` is below the function root, e.g. `/api/feed`. Returns the JSON-able answer. */
export async function route(req: Request, path: string, ctx: Ctx): Promise<unknown> {
  const url = new URL(req.url);
  const m = req.method;
  const parts = path.split("/").filter(Boolean); // ["api", "feed"]
  const [, name, id] = parts;
  if (parts[0] !== "api" || parts.length > 3) throw notFound("no such route");

  switch (name) {
    case "context":
      if (m !== "GET" || id) throw methodNotAllowed("GET /api/context");
      return await core.context(ctx, query(url));
    case "feed":
      if (m !== "GET" || id) throw methodNotAllowed("GET /api/feed");
      return await core.feed(ctx, query(url));
    case "feedback":
      if (m !== "POST" || id) throw methodNotAllowed("POST /api/feedback");
      return await core.feedback(ctx, await body(req));
    case "profile":
      if (id) throw notFound("no such route");
      if (m === "GET") return await core.profile(ctx, {});
      if (m === "PUT") return await core.profile(ctx, { set: await body(req) });
      throw methodNotAllowed("GET or PUT /api/profile");
    case "windows":
      if (m === "GET" && !id) return await core.listWindows(ctx);
      if (m === "POST" && !id) return await core.addWindow(ctx, await body(req));
      if (m === "DELETE" && id) return await core.deleteWindow(ctx, id);
      throw methodNotAllowed("GET or POST /api/windows, DELETE /api/windows/:id");
    case "runs":
      if (m !== "GET" || id) throw methodNotAllowed("GET /api/runs");
      return await core.listRuns(ctx, query(url));
    case "tokens":
      if (m === "GET" && !id) return await core.listTokens(ctx);
      if (m === "POST" && !id) return await core.createToken(ctx, await body(req));
      if (m === "DELETE" && id) return await core.revokeToken(ctx, id);
      throw methodNotAllowed("GET or POST /api/tokens, DELETE /api/tokens/:id");
    default:
      throw notFound("no such route");
  }
}

export const health = () => ({ ok: true, version: VERSION });
