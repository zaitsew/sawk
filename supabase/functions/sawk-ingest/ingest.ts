// One ingest run: read every active machine-readable source, upsert the
// events, record the run, then write the fallback rank. No model is called.

import type { Sql } from "../_shared/db.ts";
import { ADAPTERS, MACHINE_KINDS } from "../_shared/ingest/adapters.ts";
import { finalizeEvents } from "../_shared/ingest/normalize.ts";
import { hostAllowed, hostOf as hostnameOf, NOT_ALLOWED } from "../_shared/ingest/hosts.ts";
import { guardedFetch } from "../_shared/ingest/ssrf.ts";
import type { Fetch, SourceRow } from "../_shared/ingest/types.ts";
import { upsertEvents } from "../_shared/ingest/upsert.ts";
import { writeFallbackRanks } from "../_shared/score.ts";

export interface IngestOptions {
  now?: Date;
  fetch?: Fetch;
  env?: (name: string) => string | undefined;
  /** Ingest only this source. */
  sourceId?: string;
  /** Which hosts a source may be read from. Default: the ingest allow-list (hosts.ts). Tests that stub fetch widen it. */
  allowHost?: (host: string) => boolean;
  /** Write the fallback rank after ingesting. Default true. */
  rank?: boolean;
  /** Sources on one host run one after another, this far apart. Default 1000 ms. */
  politeDelayMs?: number;
  /** Sources on different hosts run in parallel. Always at most this many hosts at once. Default 6. */
  maxHosts?: number;
}

export interface SourceSummary {
  id: string;
  kind: string;
  label: string;
  events: number;
  added: number;
  updated: number;
  skipped?: boolean;
  error?: string;
}

export interface IngestSummary {
  runId: string;
  status: "ok" | "partial" | "failed";
  sources: SourceSummary[];
  eventsSeen: number;
  eventsAdded: number;
  eventsUpdated: number;
  ranked: number;
  rankedUsers: number;
  notes: string;
}

const hostOf = (s: SourceRow) => (s.kind === "ticketmaster" ? "app.ticketmaster.com" : (() => {
  try {
    return new URL(s.url).host;
  } catch {
    return s.url;
  }
})());

/** null when `sourceId` names no active source of a machine-readable kind. */
export async function runIngest(sql: Sql, opts: IngestOptions = {}): Promise<IngestSummary | null> {
  const now = opts.now ?? new Date();
  // The real fetch only reaches public addresses (ssrf.ts). A fetch passed in by a test is used as it is.
  const allowHost = opts.allowHost ?? ((h: string) => hostAllowed(h));
  const f = opts.fetch ?? guardedFetch(fetch, undefined, allowHost);
  const env = opts.env ?? ((k: string) => Deno.env.get(k));
  const delay = opts.politeDelayMs ?? 1000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const sourceId = opts.sourceId ?? null;
  const rows = await sql`
    select id, city, country, kind, url, label, categories from sawk.sources
    where active and kind = any(${sql.array(MACHINE_KINDS)}::text[])
      and (${sourceId}::uuid is null or id = ${sourceId}::uuid)
    order by kind, url`;
  if (sourceId && !rows.length) return null;
  const sources: SourceRow[] = rows.map((r) => ({
    id: r.id as string,
    city: r.city as string,
    country: (r.country as string | null) ?? null,
    kind: r.kind as SourceRow["kind"],
    url: r.url as string,
    label: r.label as string,
    categories: (r.categories as string[]) ?? [],
  }));

  const cities = [...new Set(sources.map((s) => s.city))];
  const [run] = await sql`
    insert into sawk.runs (agent, status, cities, started_at)
    values ('ingest', 'running', ${sql.array(cities)}::text[], ${now.toISOString()}::timestamptz) returning id`;
  const runId = run.id as string;

  const summaries = new Map<string, SourceSummary>();
  const cache = new Map<string, unknown>();
  // Upserts of different sources touch the same events: one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const doSource = async (source: SourceRow) => {
    const summary: SourceSummary = {
      id: source.id,
      kind: source.kind,
      label: source.label,
      events: 0,
      added: 0,
      updated: 0,
    };
    summaries.set(source.id, summary);
    // Ticketmaster is always app.ticketmaster.com; the others read the row's own URL.
    const host = source.kind === "ticketmaster" ? "app.ticketmaster.com" : hostnameOf(source.url);
    if (!host || !allowHost(host)) {
      // Skipped, not failed: agents can still read the page. It does not make the run partial.
      summary.skipped = true;
      summary.error = NOT_ALLOWED;
    } else {
      try {
        const adapter = ADAPTERS[source.kind];
        const res = await adapter(source, { fetch: f, now, env, cache });
        const fin = await finalizeEvents(res.events, source, now);
        summary.events = fin.events.length;
        if (res.error === "no key" && !fin.events.length) {
          summary.skipped = true;
          summary.error = res.error;
        } else if (res.error) summary.error = res.error;
        const up = await serial(() => upsertEvents(sql, fin.events, `${source.kind}:${source.id}`, now));
        summary.added = up.added;
        summary.updated = up.updated;
      } catch (e) {
        summary.error = `${source.kind}: ${(e as Error).message}`;
      }
    }
    const failed = !!summary.error && !summary.skipped;
    await sql`
      update sawk.sources set
        last_ok_at = case when ${
      failed || summary.skipped === true
    } then last_ok_at else ${now.toISOString()}::timestamptz end,
        last_error = ${summary.error ?? null}, last_count = ${summary.events}
      where id = ${source.id}::uuid`;
  };

  // One lane per host (politely spaced), several hosts at once.
  const lanes = new Map<string, SourceRow[]>();
  for (const s of sources) lanes.set(hostOf(s), [...(lanes.get(hostOf(s)) ?? []), s]);
  const queue = [...lanes.values()];
  const worker = async () => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) {
      for (let i = 0; i < lane.length; i++) {
        if (i > 0 && delay > 0) await sleep(delay);
        await doSource(lane[i]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.maxHosts ?? 6, queue.length) }, worker));

  let ranked = 0;
  let rankedUsers = 0;
  const notes: string[] = [];
  if (opts.rank !== false) {
    try {
      const r = await writeFallbackRanks(sql, now);
      ranked = r.ranked;
      rankedUsers = r.users;
      if (r.errors.length) notes.push(`fallback rank errors: ${r.errors.join("; ")}`);
    } catch (e) {
      notes.push(`fallback rank failed: ${(e as Error).message}`);
    }
  }

  const list = sources.map((s) => summaries.get(s.id)!).filter(Boolean);
  const attempted = list.filter((s) => !s.skipped);
  const failed = attempted.filter((s) => s.error);
  for (const s of list) if (s.error) notes.push(`${s.kind} ${s.label}: ${s.error}`);
  const status: IngestSummary["status"] = attempted.length && failed.length === attempted.length
    ? "failed"
    : failed.length || notes.some((n) => n.startsWith("fallback rank"))
    ? "partial"
    : "ok";
  const eventsSeen = list.reduce((n, s) => n + s.events, 0);
  const eventsAdded = list.reduce((n, s) => n + s.added, 0);
  const eventsUpdated = list.reduce((n, s) => n + s.updated, 0);
  const noteText = notes.join("\n").slice(0, 4000);
  await sql`
    update sawk.runs set finished_at = now(), status = ${status}, events_added = ${eventsAdded}, events_seen = ${eventsSeen},
      ranked = ${ranked}, notes = ${noteText || null}
    where id = ${runId}::uuid`;

  return { runId, status, sources: list, eventsSeen, eventsAdded, eventsUpdated, ranked, rankedUsers, notes: noteText };
}
