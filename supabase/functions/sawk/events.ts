// Events: validate what an agent sends, merge it into the shared pool, read the pool back.

import { eventId } from "../_shared/ids.ts";
import { CATEGORIES, type Category, type Event, type EventIn } from "../_shared/types.ts";
import {
  addDays,
  AppError,
  bad,
  type Ctx,
  DEFAULT_TZ,
  httpUrl,
  iso,
  num,
  type Obj,
  obj,
  optEnum,
  optInt,
  optStr,
  reqStr,
  reqUuid,
  reqYmd,
  validTz,
} from "./util.ts";
import { getProfile, ownRun } from "./core.ts";

export const MAX_EVENTS_PER_CALL = 100;
const PAST_GRACE_MS = 6 * 3_600_000;
const MAX_AHEAD_MS = 400 * 86_400_000;
const WITH_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

export interface Valid extends Required<Pick<EventIn, "title" | "city" | "url">> {
  startsAt: string;
  /** startsAt as the caller wrote it, offset kept: the event id needs its local day when tz is missing. */
  startsAtWritten: string;
  endsAt: string | null;
  allDay: boolean;
  tz: string | null;
  country: string | null;
  venue: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  category: Category;
  tags: string[];
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  isFree: boolean | null;
  ticketUrl: string | null;
  imageUrl: string | null;
  lang: string | null;
  description: string | null;
}

function instant(v: unknown, k: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw bad(`${k} is required (ISO 8601 with offset, like 2026-10-24T22:00:00+02:00)`);
  }
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || !WITH_OFFSET.test(s)) {
    throw bad(`${k} must be ISO 8601 with a UTC offset or Z, like 2026-10-24T22:00:00+02:00`);
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) throw bad(`${k} is not a real date and time`);
  return d.toISOString();
}

function optNumber(o: Obj, k: string, min: number, max: number): number | null {
  const v = o[k];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw bad(`${k} must be a number from ${min} to ${max}`);
  }
  return v;
}

function optUrl(o: Obj, k: string): string | null {
  const v = o[k];
  if (v === undefined || v === null || v === "") return null;
  return httpUrl(v, k);
}

/** Throws `bad(why)` for one event; the batch carries on. */
export function validateEvent(input: unknown, now: Date): Valid {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("event must be an object");
  const o = input as Obj;
  const title = reqStr(o, "title", 300);
  const city = reqStr(o, "city", 100);
  const url = httpUrl(o.url, "url (the page where you read about the event)");
  const startsAt = instant(o.startsAt, "startsAt");
  const t = Date.parse(startsAt);
  if (t < now.getTime() - PAST_GRACE_MS) throw bad("startsAt is in the past (events older than 6 hours are rejected)");
  if (t > now.getTime() + MAX_AHEAD_MS) throw bad("startsAt is more than 400 days ahead");
  let endsAt: string | null = null;
  if (o.endsAt !== undefined && o.endsAt !== null && o.endsAt !== "") {
    endsAt = instant(o.endsAt, "endsAt");
    if (Date.parse(endsAt) < t) throw bad("endsAt is before startsAt");
  }
  const tz = optStr(o, "tz", 64) ?? null;
  if (tz && !validTz(tz)) throw bad(`tz "${tz}" is not an IANA time zone`);
  let country: string | null = null;
  const c = optStr(o, "country", 2);
  if (c) {
    if (!/^[A-Za-z]{2}$/.test(c)) throw bad("country must be an ISO 3166-1 alpha-2 code like ES");
    country = c.toUpperCase();
  }
  const rawCategory = typeof o.category === "string" ? o.category.trim().toLowerCase() : "";
  const category: Category = (CATEGORIES as readonly string[]).includes(rawCategory)
    ? rawCategory as Category
    : "other";
  const lat = optNumber(o, "lat", -90, 90);
  const lon = optNumber(o, "lon", -180, 180);
  if ((lat === null) !== (lon === null)) throw bad("lat and lon go together");
  const priceMin = optNumber(o, "priceMin", 0, 1_000_000);
  const priceMax = optNumber(o, "priceMax", 0, 1_000_000);
  if (priceMin !== null && priceMax !== null && priceMax < priceMin) throw bad("priceMax is below priceMin");
  const currency = optStr(o, "currency", 3);
  const lang = optStr(o, "lang", 8)?.toLowerCase();
  let tags: string[] = [];
  if (o.tags !== undefined && o.tags !== null) {
    if (!Array.isArray(o.tags) || o.tags.some((x) => typeof x !== "string")) {
      throw bad("tags must be an array of strings");
    }
    tags = [...new Set((o.tags as string[]).map((x) => x.trim().toLowerCase().slice(0, 40)).filter((x) => x !== ""))]
      .slice(0, 10);
  }
  const description = optStr(o, "description", 20_000)?.slice(0, 600) ?? null;
  if (o.isFree !== undefined && o.isFree !== null && typeof o.isFree !== "boolean") {
    throw bad("isFree must be true or false");
  }
  return {
    title,
    city,
    url,
    startsAt,
    startsAtWritten: (o.startsAt as string).trim(),
    endsAt,
    allDay: o.allDay === true,
    tz,
    country,
    venue: optStr(o, "venue", 200) ?? null,
    address: optStr(o, "address", 300) ?? null,
    lat,
    lon,
    category,
    tags,
    priceMin,
    priceMax,
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null,
    isFree: (o.isFree as boolean | null | undefined) ?? null,
    ticketUrl: optUrl(o, "ticketUrl"),
    imageUrl: optUrl(o, "imageUrl"),
    lang: lang && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lang) ? lang : null,
    description,
  };
}

export interface AddResult {
  added: number;
  updated: number;
  rejected: Array<{ index: number; why: string }>;
  ids: string[];
}

export async function addEvents(ctx: Ctx, args: unknown): Promise<AddResult> {
  const a = obj(args);
  const runId = reqUuid(a, "runId");
  if (!Array.isArray(a.events) || a.events.length === 0) throw bad("events must be a non-empty array");
  if (a.events.length > MAX_EVENTS_PER_CALL) {
    throw bad(`send at most ${MAX_EVENTS_PER_CALL} events per call; split the rest into another call`);
  }
  await ownRun(ctx, runId);

  const now = ctx.now();
  const rejected: AddResult["rejected"] = [];
  const valid: Array<{ index: number; id: string; e: Valid }> = [];
  for (let index = 0; index < a.events.length; index++) {
    try {
      const e = validateEvent(a.events[index], now);
      valid.push({ index, id: await eventId({ ...e, startsAt: e.startsAtWritten }), e });
    } catch (err) {
      if (err instanceof AppError) rejected.push({ index, why: err.message });
      else throw err;
    }
  }

  let added = 0, updated = 0;
  const ids: string[] = [];
  if (valid.length > 0) {
    await ctx.sql.begin(async (tx) => {
      const known = new Set(
        (await tx<{ id: string }>`select id from sawk.events where id = any(${
          tx.array(valid.map((v) => v.id))
        }::text[])`).map((r) => r.id),
      );
      const nowIso = now.toISOString();
      for (const { id, e } of valid) {
        if (known.has(id)) updated++;
        else added++;
        known.add(id);
        ids.push(id);
        const sighting = [{ via: `agent:${runId}`, url: e.url, at: nowIso }];
        await tx`
          insert into sawk.events (id, title, description, starts_at, ends_at, all_day, tz, city, country, venue, address, lat, lon,
            category, tags, price_min, price_max, currency, is_free, url, ticket_url, image_url, lang, seen, first_seen_at, last_seen_at)
          values (${id}, ${e.title}, ${e.description}::text, ${e.startsAt}::timestamptz, ${e.endsAt}::timestamptz, ${e.allDay}::boolean,
            ${e.tz}::text, ${e.city}, ${e.country}::text, ${e.venue}::text, ${e.address}::text, ${e.lat}::float8, ${e.lon}::float8,
            ${e.category}, ${
          tx.array(e.tags)
        }::text[], ${e.priceMin}::numeric, ${e.priceMax}::numeric, ${e.currency}::text,
            ${e.isFree}::boolean, ${e.url}, ${e.ticketUrl}::text, ${e.imageUrl}::text, ${e.lang}::text, ${
          tx.json(sighting)
        }::jsonb,
            ${nowIso}::timestamptz, ${nowIso}::timestamptz)
          on conflict (id) do update set
            description = case when length(coalesce(excluded.description, '')) > length(coalesce(sawk.events.description, ''))
                                then excluded.description else sawk.events.description end,
            ends_at     = coalesce(sawk.events.ends_at, excluded.ends_at),
            tz          = coalesce(sawk.events.tz, excluded.tz),
            country     = coalesce(sawk.events.country, excluded.country),
            venue       = coalesce(sawk.events.venue, excluded.venue),
            address     = coalesce(sawk.events.address, excluded.address),
            lat         = coalesce(sawk.events.lat, excluded.lat),
            lon         = coalesce(sawk.events.lon, excluded.lon),
            category    = case when sawk.events.category = 'other' then excluded.category else sawk.events.category end,
            tags        = (select coalesce((array_agg(t order by t))[1:10], '{}')
                             from (select distinct t from unnest(sawk.events.tags || excluded.tags) as t) x),
            price_min   = coalesce(sawk.events.price_min, excluded.price_min),
            price_max   = coalesce(sawk.events.price_max, excluded.price_max),
            currency    = coalesce(sawk.events.currency, excluded.currency),
            is_free     = coalesce(sawk.events.is_free, excluded.is_free),
            ticket_url  = coalesce(sawk.events.ticket_url, excluded.ticket_url),
            image_url   = coalesce(sawk.events.image_url, excluded.image_url),
            lang        = coalesce(sawk.events.lang, excluded.lang),
            seen        = case when exists (select 1 from jsonb_array_elements(sawk.events.seen) s where s->>'url' = excluded.url)
                               then sawk.events.seen else sawk.events.seen || excluded.seen end,
            last_seen_at = excluded.last_seen_at`;
      }
      await tx`update sawk.runs set events_added = events_added + ${added}::int, events_seen = events_seen + ${
        added + updated
      }::int
               where id = ${runId}::uuid and user_id = ${ctx.userId}::uuid`;
    });
  }
  return { added, updated, rejected, ids };
}

// MARK: - reading the pool

export function rowToEvent(r: Record<string, unknown>): Event {
  return {
    id: String(r.id),
    title: String(r.title),
    startsAt: iso(r.starts_at)!,
    endsAt: iso(r.ends_at),
    allDay: r.all_day === true,
    tz: (r.tz as string | null) ?? null,
    city: String(r.city),
    country: (r.country as string | null) ?? null,
    venue: (r.venue as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    lat: num(r.lat),
    lon: num(r.lon),
    category: r.category as Category,
    tags: (r.tags as string[]) ?? [],
    priceMin: num(r.price_min),
    priceMax: num(r.price_max),
    currency: (r.currency as string | null) ?? null,
    isFree: (r.is_free as boolean | null) ?? null,
    url: String(r.url),
    ticketUrl: (r.ticket_url as string | null) ?? null,
    imageUrl: (r.image_url as string | null) ?? null,
    lang: (r.lang as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    cancelled: r.cancelled === true,
  };
}

/** Pool events in a city and date range, so an agent adds what is missing instead of repeating what is known. */
export async function listEvents(ctx: Ctx, args: unknown) {
  const a = obj(args);
  const city = reqStr(a, "city", 100);
  const from = reqYmd(a, "from");
  const to = reqYmd(a, "to");
  if (to < from) throw bad("to is before from");
  if (addDays(from, 120) < to) throw bad("ask for at most 120 days at a time");
  const category = optEnum(a, "category", CATEGORIES);
  const limit = optInt(a, "limit", 1, 500) ?? 200;
  const tz = (await getProfile(ctx.sql, ctx.userId)).homeTz ?? DEFAULT_TZ;
  const rows = await ctx.sql`
    select e.id, e.title, e.starts_at, e.ends_at, e.all_day, e.tz, e.city, e.venue, e.category, e.price_min, e.is_free, e.url,
           f.score, f.state
    from sawk.events e
    left join sawk.feed f on f.event_id = e.id and f.user_id = ${ctx.userId}::uuid
    where lower(e.city) = lower(${city}::text) and not e.cancelled
      and (e.starts_at at time zone coalesce(e.tz, ${tz}::text))::date between ${from}::date and ${to}::date
      and (${category ?? null}::text is null or e.category = ${category ?? null}::text)
    order by e.starts_at
    limit ${limit}::int`;
  return {
    events: rows.map((r) => ({
      id: r.id,
      title: r.title,
      startsAt: iso(r.starts_at),
      endsAt: iso(r.ends_at),
      allDay: r.all_day === true || undefined,
      city: r.city,
      venue: r.venue,
      category: r.category,
      priceMin: num(r.price_min),
      isFree: r.is_free,
      url: r.url,
      // Present when you (this person) already have it in the feed: no need to rank it again unless you changed your mind.
      score: r.score === null ? undefined : Number(r.score),
      state: r.state ?? undefined,
    })),
  };
}
