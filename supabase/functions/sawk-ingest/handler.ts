// POST /sawk-ingest — the daily call from pg_cron (migration 0004).
//
//   x-sawk-cron: <SAWK_CRON_SECRET>      required
//   ?source=<sources.id>                 ingest one source only
//
// Deploy with --no-verify-jwt: the caller is the database, authenticated by
// the shared secret, not by a user session.

import { db, type Sql } from "../_shared/db.ts";
import { type IngestOptions, runIngest } from "./ingest.ts";

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compares two strings in time that does not depend on where they differ (or their lengths). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

export interface Deps {
  sql?: Sql;
  options?: IngestOptions;
  secret?: string;
}

export function makeHandler(deps: Deps = {}) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "POST only" }, 405, { allow: "POST" });
    const secret = deps.secret ?? Deno.env.get("SAWK_CRON_SECRET");
    if (!secret) return json({ error: "SAWK_CRON_SECRET is not set" }, 503);
    const given = req.headers.get("x-sawk-cron") ?? "";
    if (!(await safeEqual(given, secret))) return json({ error: "unauthorized" }, 401);

    const source = new URL(req.url).searchParams.get("source");
    if (source !== null && !UUID.test(source)) return json({ error: "source must be a source id (uuid)" }, 400);

    try {
      const summary = await runIngest(deps.sql ?? db(), { ...deps.options, sourceId: source ?? undefined });
      if (!summary) return json({ error: "no active machine-readable source with that id" }, 404);
      return json(summary);
    } catch (e) {
      console.error("sawk-ingest failed", e);
      return json({ error: "ingest failed", detail: (e as Error).message }, 500);
    }
  };
}

export const handler = makeHandler();
