// The core: every operation, written once. The MCP tools and the REST routes are
// thin adapters over these functions. Each takes a `Ctx` (the caller) and loose
// `unknown` input, validates it, and filters every personal query by `ctx.userId`.

import { newTokenText, sha256Hex } from "./auth.ts";
import { rowToEvent } from "./events.ts";
import {
  type Action,
  ACTIONS,
  CATEGORIES,
  FEED_STATES,
  type FeedItem,
  type FeedState,
  type Profile,
  SOURCE_KINDS,
  type Window,
} from "../_shared/types.ts";
import type { Sql } from "../_shared/db.ts";
import {
  addDays,
  AppError,
  bad,
  compact,
  type Ctx,
  daysBetween,
  DEFAULT_TZ,
  forbidden,
  iso,
  notFound,
  obj,
  optCountry,
  optEnum,
  optInt,
  optNum,
  optStr,
  optTz,
  optYmd,
  publicHttpUrl,
  reqEnum,
  reqStr,
  reqUuid,
  reqYmd,
  strList,
  todayIn,
  UUID,
  ymdOf,
} from "./util.ts";

// MARK: - profile

const DEFAULT_PROFILE: Profile = {
  homeCity: null,
  homeCountry: null,
  homeTz: null,
  langs: ["en"],
  likes: [],
  avoids: [],
  notes: "",
  priceMax: null,
  currency: "EUR",
  maxPerDay: 3,
};

function rowToProfile(r: Record<string, unknown>): Profile {
  return {
    homeCity: (r.home_city as string | null) ?? null,
    homeCountry: (r.home_country as string | null) ?? null,
    homeTz: (r.home_tz as string | null) ?? null,
    langs: (r.langs as string[]) ?? [],
    likes: (r.likes as string[]) ?? [],
    avoids: (r.avoids as string[]) ?? [],
    notes: String(r.notes ?? ""),
    priceMax: r.price_max == null ? null : Number(r.price_max),
    currency: String(r.currency ?? "EUR"),
    maxPerDay: Number(r.max_per_day ?? 3),
    updatedAt: iso(r.updated_at) ?? undefined,
  };
}

export async function getProfile(sql: Sql, userId: string): Promise<Profile> {
  const rows = await sql`select * from sawk.profiles where user_id = ${userId}::uuid`;
  return rows[0] ? rowToProfile(rows[0]) : { ...DEFAULT_PROFILE };
}

/** `set` is a partial profile: only the keys present change; null clears homeCity, homeCountry, homeTz and priceMax. */
export async function profile(ctx: Ctx, args: unknown): Promise<Profile> {
  const a = obj(args);
  if (a.set === undefined || a.set === null) return await getProfile(ctx.sql, ctx.userId);
  const set = obj(a.set, "set");
  const known = [
    "homeCity",
    "homeCountry",
    "homeTz",
    "langs",
    "likes",
    "avoids",
    "notes",
    "priceMax",
    "currency",
    "maxPerDay",
  ];
  const unknown = Object.keys(set).filter((k) => !known.includes(k));
  if (unknown.length) throw bad(`unknown profile field(s): ${unknown.join(", ")}. Fields: ${known.join(", ")}`);

  return await ctx.sql.begin(async (tx) => {
    // Lock the row so two partial updates (likes from one client, priceMax from another) both land.
    await tx`insert into sawk.profiles (user_id) values (${ctx.userId}::uuid) on conflict (user_id) do nothing`;
    const cur = rowToProfile((await tx`select * from sawk.profiles where user_id = ${ctx.userId}::uuid for update`)[0]);
    const next: Profile = { ...cur };
    const has = (k: string) => k in set;
    if (has("homeCity")) next.homeCity = set.homeCity === null ? null : reqStr(set, "homeCity", 100);
    if (has("homeCountry")) {
      next.homeCountry = set.homeCountry === null ? null : (optCountry(set, "homeCountry") ?? null);
    }
    if (has("homeTz")) next.homeTz = set.homeTz === null ? null : (optTz(set, "homeTz") ?? null);
    if (has("langs")) next.langs = strList(set.langs, "langs", 30, 40);
    if (has("likes")) next.likes = strList(set.likes, "likes", 30, 40);
    if (has("avoids")) next.avoids = strList(set.avoids, "avoids", 30, 40);
    if (has("notes")) {
      if (typeof set.notes !== "string") throw bad("notes must be a string");
      if (set.notes.length > 2000) throw bad("notes is longer than 2000 characters");
      next.notes = set.notes.trim();
    }
    if (has("priceMax")) next.priceMax = set.priceMax === null ? null : (optNum(set, "priceMax", 0, 1_000_000) ?? null);
    if (has("currency")) {
      const c = optStr(set, "currency", 3);
      if (!c || !/^[A-Za-z]{3}$/.test(c)) throw bad("currency must be a 3-letter code like EUR");
      next.currency = c.toUpperCase();
    }
    if (has("maxPerDay")) next.maxPerDay = optInt(set, "maxPerDay", 1, 10) ?? cur.maxPerDay;

    const rows = await tx`
      insert into sawk.profiles (user_id, home_city, home_country, home_tz, langs, likes, avoids, notes, price_max, currency, max_per_day, updated_at)
      values (${ctx.userId}::uuid, ${next.homeCity}::text, ${next.homeCountry}::text, ${next.homeTz}::text,
              ${tx.array(next.langs)}::text[], ${tx.array(next.likes)}::text[], ${tx.array(next.avoids)}::text[],
              ${next.notes}::text, ${next.priceMax}::numeric, ${next.currency}::text, ${next.maxPerDay}::smallint, ${ctx.now().toISOString()}::timestamptz)
      on conflict (user_id) do update set
        home_city = excluded.home_city, home_country = excluded.home_country, home_tz = excluded.home_tz,
        langs = excluded.langs, likes = excluded.likes, avoids = excluded.avoids, notes = excluded.notes,
        price_max = excluded.price_max, currency = excluded.currency, max_per_day = excluded.max_per_day,
        updated_at = excluded.updated_at
      returning *`;
    return rowToProfile(rows[0]);
  });
}

// MARK: - runs

const RUN_STATUS = ["ok", "partial", "failed"] as const;

function rowToRun(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    agent: String(r.agent),
    model: (r.model as string | null) ?? null,
    startedAt: iso(r.started_at)!,
    finishedAt: iso(r.finished_at),
    status: String(r.status),
    cities: (r.cities as string[]) ?? [],
    eventsAdded: Number(r.events_added),
    eventsSeen: Number(r.events_seen),
    ranked: Number(r.ranked),
    notes: (r.notes as string | null) ?? null,
  };
}

/** The caller's own run, or `not_found`. Runs are never shared. */
export async function ownRun(ctx: Ctx, runId: string): Promise<Record<string, unknown>> {
  if (!UUID.test(runId)) throw bad("runId must be the id returned by sawk_run_start");
  const rows = await ctx.sql`select * from sawk.runs where id = ${runId}::uuid and user_id = ${ctx.userId}::uuid`;
  if (!rows[0]) throw notFound("no such run for you; call sawk_run_start to get a runId");
  return rows[0];
}

export async function runStart(ctx: Ctx, args: unknown) {
  const a = obj(args);
  const agent = reqStr(a, "agent", 40);
  const model = optStr(a, "model", 80) ?? null;
  const cities = a.cities === undefined || a.cities === null ? [] : strList(a.cities, "cities", 20, 100);
  const rows = await ctx.sql`
    insert into sawk.runs (user_id, agent, model, cities, started_at)
    values (${ctx.userId}::uuid, ${agent}, ${model}::text, ${
    ctx.sql.array(cities)
  }::text[], ${ctx.now().toISOString()}::timestamptz)
    returning id`;
  return { runId: String(rows[0].id) };
}

export async function runFinish(ctx: Ctx, args: unknown) {
  const a = obj(args);
  const runId = reqUuid(a, "runId");
  const status = reqEnum(a, "status", RUN_STATUS);
  const notes = optStr(a, "notes", 2000) ?? null;
  await ownRun(ctx, runId);
  const rows = await ctx.sql`
    update sawk.runs set status = ${status}, notes = ${notes}::text, finished_at = ${ctx.now().toISOString()}::timestamptz
    where id = ${runId}::uuid and user_id = ${ctx.userId}::uuid returning *`;
  return rowToRun(rows[0]);
}

export async function listRuns(ctx: Ctx, args: unknown) {
  const limit = optInt(obj(args), "limit", 1, 100) ?? 20;
  const rows = await ctx
    .sql`select * from sawk.runs where user_id = ${ctx.userId}::uuid order by started_at desc limit ${limit}::int`;
  return { runs: rows.map(rowToRun) };
}

// MARK: - rank

export async function rank(ctx: Ctx, args: unknown) {
  const a = obj(args);
  const runId = reqUuid(a, "runId");
  if (!Array.isArray(a.items) || a.items.length === 0) {
    throw bad("items must be a non-empty array of {eventId, score, reason}");
  }
  if (a.items.length > 200) throw bad("send at most 200 items per call");
  await ownRun(ctx, runId);

  const rejected: Array<{ index: number; why: string }> = [];
  const byId = new Map<string, { index: number; score: number; reason: string }>();
  a.items.forEach((raw: unknown, index: number) => {
    try {
      const it = obj(raw, "item");
      const eventId = reqStr(it, "eventId", 80);
      const s = typeof it.score === "string" && it.score.trim() !== "" ? Number(it.score) : it.score;
      if (typeof s !== "number" || !Number.isFinite(s)) throw bad("score must be a number from 0 to 1");
      const reason = reqStr(it, "reason", 20_000).slice(0, 280);
      byId.set(eventId, { index, score: Math.min(1, Math.max(0, s)), reason });
    } catch (e) {
      if (e instanceof AppError) rejected.push({ index, why: e.detail });
      else throw e;
    }
  });

  let ranked = 0;
  if (byId.size > 0) {
    await ctx.sql.begin(async (tx) => {
      const ids = [...byId.keys()];
      const exist = new Set(
        (await tx<{ id: string }>`select id from sawk.events where id = any(${tx.array(ids)}::text[])`).map((r) =>
          r.id
        ),
      );
      const at = ctx.now().toISOString();
      for (const [eventId, it] of byId) {
        if (!exist.has(eventId)) {
          rejected.push({
            index: it.index,
            why: `unknown eventId ${eventId}; add the event with sawk_add_events first`,
          });
          continue;
        }
        // The person's state and rating are never touched; an agent's rank always replaces score and reason.
        await tx`
          insert into sawk.feed (user_id, event_id, score, reason, ranked_by, ranked_at, updated_at)
          values (${ctx.userId}::uuid, ${eventId}, ${it.score}::real, ${it.reason}, ${
          "agent:" + runId
        }, ${at}::timestamptz, ${at}::timestamptz)
          on conflict (user_id, event_id) do update set
            score = excluded.score, reason = excluded.reason, ranked_by = excluded.ranked_by,
            ranked_at = excluded.ranked_at, updated_at = excluded.updated_at`;
        ranked++;
      }
      await tx`update sawk.runs set ranked = ranked + ${ranked}::int where id = ${runId}::uuid and user_id = ${ctx.userId}::uuid`;
    });
  }
  rejected.sort((x, y) => x.index - y.index);
  return rejected.length ? { ranked, rejected } : { ranked };
}

// MARK: - feed

function rowToFeedItem(r: Record<string, unknown>): FeedItem {
  return {
    event: rowToEvent(r),
    score: Math.round(Number(r.score) * 10_000) / 10_000, // real (float4) in, so 0.95 does not come back as 0.949999988
    reason: String(r.reason),
    rankedBy: String(r.ranked_by),
    rankedAt: iso(r.ranked_at)!,
    state: r.state as FeedState,
    rating: r.rating == null ? null : Number(r.rating),
  };
}

export async function feed(ctx: Ctx, args: unknown) {
  const a = obj(args);
  const tz = (await getProfile(ctx.sql, ctx.userId)).homeTz ?? DEFAULT_TZ;
  const now = ctx.now();
  const today = todayIn(tz, now);
  const from = optYmd(a, "from") ?? today;
  const to = optYmd(a, "to") ?? addDays(from, 14);
  if (to < from) throw bad("to is before from");
  if (addDays(from, 120) < to) throw bad("ask for at most 120 days at a time");
  const city = optStr(a, "city", 100) ?? null;
  const state = optEnum(a, "state", FEED_STATES) ?? null;
  const limit = optInt(a, "limit", 1, 200) ?? 30;
  const rows = await ctx.sql`
    select e.*, f.score, f.reason, f.ranked_by, f.ranked_at, f.state, f.rating
    from sawk.feed f join sawk.events e on e.id = f.event_id
    where f.user_id = ${ctx.userId}::uuid
      and not e.cancelled
      and (e.starts_at at time zone coalesce(e.tz, ${tz}::text))::date between ${from}::date and ${to}::date
      and (f.state in ('saved', 'going', 'went')
           or case when e.all_day then (e.starts_at at time zone coalesce(e.tz, ${tz}::text))::date >= ${today}::date
                   else coalesce(e.ends_at, e.starts_at) >= ${now.toISOString()}::timestamptz - interval '3 hours' end)
      and (${city}::text is null or e.city_key = sawk.city_key(${city}::text))
      and (case when ${state}::text is null then f.state <> 'hidden' else f.state = ${state}::text end)
    order by (e.starts_at at time zone coalesce(e.tz, ${tz}::text))::date, f.score desc, e.starts_at
    limit ${limit}::int`;
  return { from, to, items: rows.map(rowToFeedItem) };
}

async function feedItem(sql: Sql, userId: string, eventId: string): Promise<FeedItem> {
  const rows = await sql`
    select e.*, f.score, f.reason, f.ranked_by, f.ranked_at, f.state, f.rating
    from sawk.feed f join sawk.events e on e.id = f.event_id
    where f.user_id = ${userId}::uuid and f.event_id = ${eventId}`;
  return rowToFeedItem(rows[0]);
}

// MARK: - feedback

const STATE_OF: Partial<Record<Action, FeedState>> = {
  save: "saved",
  unsave: "new",
  going: "going",
  hide: "hidden",
  went: "went",
  skip: "skipped",
};

export async function feedback(ctx: Ctx, args: unknown): Promise<FeedItem> {
  const a = obj(args);
  const eventId = reqStr(a, "eventId", 80);
  const action = reqEnum(a, "action", ACTIONS);
  const rating = optInt(a, "rating", -2, 2);
  if (action === "rate" && rating === undefined) throw bad("rating is required for action rate (-2 to 2)");
  const note = optStr(a, "note", 500) ?? null;
  const via = ctx.client;

  return await ctx.sql.begin(async (tx) => {
    if (!(await tx`select 1 from sawk.events where id = ${eventId}`).length) throw notFound(`no event ${eventId}`);
    await tx`
      insert into sawk.feedback (user_id, event_id, action, rating, note, via, at)
      values (${ctx.userId}::uuid, ${eventId}, ${action}, ${
      rating ?? null
    }::smallint, ${note}::text, ${via}, ${ctx.now().toISOString()}::timestamptz)`;

    // Acting on an event nobody ranked for this person (they added it themselves): give it a row.
    // `do nothing` keeps a row a ranker inserted meanwhile; the lock below then reads it.
    await tx`
      insert into sawk.feed (user_id, event_id, score, reason, ranked_by)
      values (${ctx.userId}::uuid, ${eventId}, 0.5, 'You added this yourself.', 'person')
      on conflict (user_id, event_id) do nothing`;
    const cur =
      (await tx`select state, rating from sawk.feed where user_id = ${ctx.userId}::uuid and event_id = ${eventId} for update`)[
        0
      ];
    let state = cur.state as FeedState;
    let newRating = cur.rating == null ? null : Number(cur.rating);
    if (action === "rate") {
      newRating = rating!;
      if (state === "new" || state === "saved" || state === "going") state = "went";
    } else {
      state = STATE_OF[action] ?? state;
      if (action === "went" && rating !== undefined) newRating = rating;
    }
    await tx`
      update sawk.feed set state = ${state}, rating = ${newRating}::smallint, updated_at = ${ctx.now().toISOString()}::timestamptz
      where user_id = ${ctx.userId}::uuid and event_id = ${eventId}`;
    return await feedItem(tx, ctx.userId, eventId);
  });
}

// MARK: - sources

function rowToSource(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    city: String(r.city),
    country: (r.country as string | null) ?? null,
    kind: String(r.kind),
    url: String(r.url),
    label: String(r.label),
    categories: (r.categories as string[]) ?? [],
    active: r.active === true,
    lastOkAt: iso(r.last_ok_at),
    lastError: (r.last_error as string | null) ?? null,
    lastCount: r.last_count == null ? null : Number(r.last_count),
  };
}

export async function addSource(ctx: Ctx, args: unknown) {
  const a = obj(args);
  const city = reqStr(a, "city", 100);
  const country = optCountry(a, "country") ?? null;
  const kind = reqEnum(a, "kind", SOURCE_KINDS);
  const url = publicHttpUrl(a.url, "url");
  const label = reqStr(a, "label", 120);
  const categories = a.categories === undefined || a.categories === null
    ? []
    : [...new Set(strList(a.categories, "categories", 15, 20).map((c) => c.toLowerCase()))].filter((c) =>
      (CATEGORIES as readonly string[]).includes(c)
    );
  // A source is shared by everyone in the city; adding a known one only switches it back on.
  const rows = await ctx.sql`
    insert into sawk.sources (city, country, kind, url, label, categories, added_by)
    values (${city}, ${country}::text, ${kind}, ${url}, ${label}, ${
    ctx.sql.array(categories)
  }::text[], ${ctx.userId}::uuid)
    on conflict (kind, url) do update set active = true
    returning *`;
  return rowToSource(rows[0]);
}

// MARK: - windows

function rowToManualWindow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    city: String(r.city),
    country: (r.country as string | null) ?? null,
    tz: (r.tz as string | null) ?? null,
    from: String(r.starts_on),
    to: String(r.ends_on),
    note: (r.note as string | null) ?? null,
  };
}

export async function addWindow(ctx: Ctx, args: unknown) {
  const a = obj(args);
  const city = reqStr(a, "city", 100);
  const country = optCountry(a, "country") ?? null;
  const tz = optTz(a, "tz") ?? null;
  const from = reqYmd(a, "from");
  const to = reqYmd(a, "to");
  const note = optStr(a, "note", 300) ?? null;
  if (to < from) throw bad("to is before from");
  if (daysBetween(from, to) > 366) throw bad("a window is at most 366 days long");
  const dup = await ctx.sql`
    select id::text as id, city, country, tz, starts_on::text as starts_on, ends_on::text as ends_on, note from sawk.windows
    where user_id = ${ctx.userId}::uuid and sawk.city_key(city) = sawk.city_key(${city}::text) and starts_on = ${from}::date and ends_on = ${to}::date`;
  if (dup[0]) return rowToManualWindow(dup[0]);
  const rows = await ctx.sql`
    insert into sawk.windows (user_id, city, country, tz, starts_on, ends_on, note)
    values (${ctx.userId}::uuid, ${city}, ${country}::text, ${tz}::text, ${from}::date, ${to}::date, ${note}::text)
    returning id::text as id, city, country, tz, starts_on::text as starts_on, ends_on::text as ends_on, note`;
  return rowToManualWindow(rows[0]);
}

export async function listWindows(ctx: Ctx) {
  const tz = (await getProfile(ctx.sql, ctx.userId)).homeTz ?? DEFAULT_TZ;
  const today = todayIn(tz, ctx.now());
  const rows = await ctx.sql`
    select id::text as id, city, country, tz, starts_on::text as starts_on, ends_on::text as ends_on, note from sawk.windows
    where user_id = ${ctx.userId}::uuid and ends_on >= ${today}::date order by starts_on`;
  return { windows: rows.map(rowToManualWindow) };
}

export async function deleteWindow(ctx: Ctx, id: string) {
  if (!UUID.test(id)) throw notFound("no such window");
  const rows = await ctx
    .sql`delete from sawk.windows where id = ${id}::uuid and user_id = ${ctx.userId}::uuid returning id`;
  if (!rows[0]) throw notFound("no such window");
  return { ok: true };
}

// MARK: - tokens (a signed-in session only: a leaked agent token must not mint more)

function requireSession(ctx: Ctx) {
  if (ctx.auth !== "jwt") {
    throw forbidden(
      "Tokens are managed from a signed-in session (the web app), not with an agent token or an agent's OAuth connection.",
    );
  }
}

const rowToToken = (r: Record<string, unknown>) => ({
  id: String(r.id),
  name: String(r.name),
  prefix: String(r.prefix),
  createdAt: iso(r.created_at)!,
  lastUsedAt: iso(r.last_used_at),
  revokedAt: iso(r.revoked_at),
});

export async function listTokens(ctx: Ctx) {
  requireSession(ctx);
  const rows = await ctx.sql`select id, name, prefix, created_at, last_used_at, revoked_at from sawk.tokens
                             where user_id = ${ctx.userId}::uuid order by created_at desc`;
  return { tokens: rows.map(rowToToken) };
}

export async function createToken(ctx: Ctx, args: unknown) {
  requireSession(ctx);
  const name = reqStr(obj(args), "name", 60);
  const active = await ctx.sql<
    { n: number }
  >`select count(*)::int as n from sawk.tokens where user_id = ${ctx.userId}::uuid and revoked_at is null`;
  if (Number(active[0].n) >= 20) throw bad("20 active tokens is the limit; revoke one first");
  const token = newTokenText();
  const rows = await ctx.sql`
    insert into sawk.tokens (user_id, name, hash, prefix, created_at)
    values (${ctx.userId}::uuid, ${name}, ${await sha256Hex(token)}, ${
    token.slice(0, 12)
  }, ${ctx.now().toISOString()}::timestamptz)
    returning id, name, prefix, created_at, last_used_at, revoked_at`;
  // The only time the plaintext exists outside the person's hands.
  return { ...rowToToken(rows[0]), token };
}

export async function revokeToken(ctx: Ctx, id: string) {
  requireSession(ctx);
  if (!UUID.test(id)) throw notFound("no such token");
  const rows = await ctx.sql`
    update sawk.tokens set revoked_at = ${ctx.now().toISOString()}::timestamptz
    where id = ${id}::uuid and user_id = ${ctx.userId}::uuid and revoked_at is null returning id`;
  if (!rows[0]) throw notFound("no such active token");
  return { ok: true };
}

// MARK: - context

export async function context(ctx: Ctx, args: unknown) {
  const a = obj(args);
  const days = optInt(a, "days", 1, 60) ?? 21;
  const sql = ctx.sql;
  const now = ctx.now();
  const prof = await getProfile(sql, ctx.userId);
  const lhome = prof.homeCity
    ? null
    : (await sql`select city, country, tz from sawk.loco_home(${ctx.userId}::uuid)`)[0];
  const homeTz = prof.homeTz ?? (lhome?.tz as string | undefined) ?? DEFAULT_TZ;
  const today = todayIn(homeTz, now);
  const end = addDays(today, days);
  const hints: string[] = [];

  // Trips: Loco's stays and the person's own manual windows, clipped to the range.
  const trips: Window[] = [];
  for (
    const r of await sql`select city, country, tz, starts_on::text as starts_on, ends_on::text as ends_on, trip
                            from sawk.loco_windows(${ctx.userId}::uuid, ${today}::date, ${end}::date)`
  ) {
    trips.push({
      city: String(r.city),
      country: (r.country as string | null) ?? null,
      tz: (r.tz as string | null) ?? null,
      from: ymdOf(r.starts_on),
      to: ymdOf(r.ends_on),
      source: "loco",
      note: (r.trip as string | null) ?? null,
    });
  }
  for (
    const r
      of await sql`select id::text as id, city, country, tz, starts_on::text as starts_on, ends_on::text as ends_on, note
                            from sawk.windows where user_id = ${ctx.userId}::uuid and ends_on >= ${today}::date and starts_on <= ${end}::date`
  ) {
    trips.push({
      id: String(r.id),
      city: String(r.city),
      country: (r.country as string | null) ?? null,
      tz: (r.tz as string | null) ?? null,
      from: ymdOf(r.starts_on),
      to: ymdOf(r.ends_on),
      source: "manual",
      note: (r.note as string | null) ?? null,
    });
  }
  for (const t of trips) {
    if (t.from < today) t.from = today;
    if (t.to > end) t.to = end;
  }

  // Home covers every day of [today, end] that no trip covers.
  const covered = new Set<string>();
  for (const t of trips) for (let d = t.from; d <= t.to; d = addDays(d, 1)) covered.add(d);
  const homeCity = prof.homeCity ?? (lhome?.city as string | undefined) ?? null;
  const windows: Window[] = [...trips];
  if (homeCity) {
    const country = prof.homeCity ? prof.homeCountry : ((lhome?.country as string | undefined) ?? prof.homeCountry);
    let start: string | null = null;
    for (let d = today; d <= addDays(end, 1); d = addDays(d, 1)) {
      const free = d <= end && !covered.has(d);
      if (free && start === null) start = d;
      if (!free && start !== null) {
        windows.push({
          city: homeCity,
          country: country ?? null,
          tz: homeTz,
          from: start,
          to: addDays(d, -1),
          source: "home",
        });
        start = null;
      }
    }
  } else {
    hints.push(
      "No home city is set. Ask the person where they live and call sawk_profile_update with set.homeCity (and homeCountry, homeTz).",
    );
  }
  windows.sort((x, y) => x.from.localeCompare(y.from) || x.city.localeCompare(y.city));
  if (windows.length === 0 && homeCity) hints.push("No windows in range.");

  const busy =
    (await sql`select day::text as day, title, starts_at, ends_at, city, kind from sawk.loco_busy(${ctx.userId}::uuid, ${today}::date, ${end}::date)`)
      .map((r) => ({
        day: ymdOf(r.day),
        title: r.title,
        startsAt: iso(r.starts_at),
        endsAt: iso(r.ends_at),
        city: r.city,
        kind: r.kind,
      }));
  const taste = (await sql`select sawk.loco_taste(${ctx.userId}::uuid) as t`)[0]?.t ?? null;

  // History: what the person did with the feed in the last 90 days.
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const counts: Record<string, Record<string, number>> = {};
  for (
    const r of await sql`
      select e.category, f.action, count(*)::int as n from sawk.feedback f join sawk.events e on e.id = f.event_id
      where f.user_id = ${ctx.userId}::uuid and f.at >= ${since}::timestamptz group by e.category, f.action`
  ) {
    (counts[String(r.category)] ??= {})[String(r.action)] = Number(r.n);
  }
  const recent = (await sql`
      select e.title, e.category, f.action, f.rating, f.at from sawk.feedback f join sawk.events e on e.id = f.event_id
      where f.user_id = ${ctx.userId}::uuid and f.at >= ${since}::timestamptz and f.action <> 'unsave'
      order by f.at desc, f.id desc limit 30`)
    .map((r) => ({
      title: r.title,
      category: r.category,
      action: r.action,
      rating: r.rating == null ? null : Number(r.rating),
      at: iso(r.at)!.slice(0, 10),
    }));

  // Sources and the pool, per window city. A city is its key: "Валенсия" and "Valencia" are one place.
  const written = [...new Set(windows.map((w) => w.city))];
  const keyOf = new Map<string, { key: string; name: string | null }>();
  if (written.length) {
    for (
      const r of await sql`select c as city, sawk.city_key(c) as key, sawk.city_name(sawk.city_key(c)) as name
                           from unnest(${sql.array(written)}::text[]) as c`
    ) keyOf.set(String(r.city), { key: String(r.key), name: (r.name as string | null) ?? null });
  }
  for (const w of windows) {
    // The name the sources and the web use, when the person's own spelling is another.
    const name = keyOf.get(w.city)?.name;
    if (name && name !== w.city) w.canonical = name;
  }
  const cities = new Map<string, string>(); // key -> as written first
  for (const w of windows) {
    const key = keyOf.get(w.city)!.key;
    if (!cities.has(key)) cities.set(key, w.city);
  }
  const sources = cities.size === 0 ? [] : (await sql`
      select id::text as id, city, kind, url, label, categories, last_ok_at, last_error from sawk.sources
      where active and city_key = any(${sql.array([...cities.keys()])}::text[]) order by city_key, kind, label`)
    .map((r) => ({
      id: r.id,
      city: r.city,
      kind: r.kind,
      url: r.url,
      label: r.label,
      categories: (r.categories as string[]).length ? r.categories : null,
      lastOkAt: iso(r.last_ok_at),
      lastError: r.last_error,
    }));
  const pool: Record<string, number> = {};
  for (const w of windows) {
    const cityKey = keyOf.get(w.city)!.key;
    const key = cities.get(cityKey)!;
    const tz = w.tz ?? homeTz;
    const n = (await sql<{ n: number }>`
        select count(*)::int as n from sawk.events e
        where e.city_key = ${cityKey} and not e.cancelled and e.starts_at >= ${now.toISOString()}::timestamptz
          and (e.starts_at at time zone coalesce(e.tz, ${tz}::text))::date between ${w.from}::date and ${w.to}::date`)[
      0
    ].n;
    pool[key] = (pool[key] ?? 0) + Number(n);
  }

  const lastRuns =
    (await sql`select * from sawk.runs where user_id = ${ctx.userId}::uuid order by started_at desc limit 3`)
      .map((r) => {
        const x = rowToRun(r);
        return {
          id: x.id,
          agent: x.agent,
          model: x.model,
          startedAt: x.startedAt,
          status: x.status,
          eventsAdded: x.eventsAdded,
          ranked: x.ranked,
          notes: x.notes,
        };
      });

  return compact({
    today,
    profile: prof,
    windows,
    busy,
    taste,
    history: { counts, recent },
    sources,
    pool,
    lastRuns,
    hints: hints.length ? hints : null,
  });
}
