// Writing events to sawk.events. The same concert from two sources lands on
// one row: by id when title, local date, venue and city agree, and by title,
// date and city when one of the two sightings has no venue. Fields merge
// richer-wins; nothing a person or an agent wrote is blanked.

import type { Row, Sql } from "../db.ts";
import { localDate, norm } from "../ids.ts";
import { DAY } from "./time.ts";
import type { ReadyEvent } from "./normalize.ts";

export interface Sighting {
  via: string;
  url: string;
  at: string;
}

export interface UpsertResult {
  added: number;
  updated: number;
  /** Cancelled events no one had seen before. */
  skipped: number;
}

const MAX_SEEN = 20;
const MAX_TAGS = 12;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | number | Date).toISOString());
const numOrNull = (v: unknown): number | null => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));

function parseSeen(v: unknown): Sighting[] {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return [];
    }
  }
  return Array.isArray(x) ? (x as Sighting[]).filter((s) => s && typeof s.url === "string") : [];
}

export interface Merged {
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  tz: string | null;
  city: string;
  country: string | null;
  venue: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  category: string;
  tags: string[];
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  isFree: boolean | null;
  url: string;
  ticketUrl: string | null;
  imageUrl: string | null;
  lang: string | null;
  cancelled: boolean;
  seen: Sighting[];
}

/** The row as the database holds it, in the shape `mergeEvent` works with. */
export function fromRow(r: Row): Merged {
  return {
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    startsAt: iso(r.starts_at)!,
    endsAt: iso(r.ends_at),
    allDay: r.all_day === true,
    tz: (r.tz as string | null) ?? null,
    city: r.city as string,
    country: (r.country as string | null) ?? null,
    venue: (r.venue as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    lat: numOrNull(r.lat),
    lon: numOrNull(r.lon),
    category: r.category as string,
    tags: (r.tags as string[]) ?? [],
    priceMin: numOrNull(r.price_min),
    priceMax: numOrNull(r.price_max),
    currency: (r.currency as string | null) ?? null,
    isFree: (r.is_free as boolean | null) ?? null,
    url: r.url as string,
    ticketUrl: (r.ticket_url as string | null) ?? null,
    imageUrl: (r.image_url as string | null) ?? null,
    lang: (r.lang as string | null) ?? null,
    cancelled: r.cancelled === true,
    seen: parseSeen(r.seen),
  };
}

export function fromIncoming(e: ReadyEvent): Omit<Merged, "seen"> {
  return {
    title: e.title,
    description: e.description ?? null,
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    allDay: e.allDay,
    tz: e.tz,
    city: e.city,
    country: e.country,
    venue: e.venue ?? null,
    address: e.address ?? null,
    lat: e.lat ?? null,
    lon: e.lon ?? null,
    category: e.category,
    tags: e.tags,
    priceMin: e.priceMin ?? null,
    priceMax: e.priceMax ?? null,
    currency: e.currency ?? null,
    isFree: e.isFree ?? null,
    url: e.url,
    ticketUrl: e.ticketUrl ?? null,
    imageUrl: e.imageUrl ?? null,
    lang: e.lang ?? null,
    cancelled: e.cancelled,
  };
}

/** Existing row + one more sighting. `via` is "ics:<source id>" and the like. */
export function mergeEvent(existing: Merged | null, inc: ReadyEvent, via: string, now: Date): Merged {
  const n = fromIncoming(inc);
  const sighting: Sighting = { via, url: inc.url, at: now.toISOString() };
  if (!existing) return { ...n, seen: [sighting] };

  const sameSource = existing.seen.some((s) => s.via === via);
  // Times: the source that saw it before is the authority on a change; otherwise a timed reading beats an all-day one.
  const takeTimes = sameSource || (existing.allDay && !n.allDay);
  const seen = existing.seen.filter((s) => s.url !== sighting.url || s.via !== via);
  seen.push(sighting);

  const hasPrice = existing.priceMin !== null || existing.priceMax !== null;
  return {
    title: existing.title,
    description: (n.description?.length ?? 0) > (existing.description?.length ?? 0)
      ? n.description
      : existing.description,
    startsAt: takeTimes ? n.startsAt : existing.startsAt,
    endsAt: takeTimes ? n.endsAt : existing.endsAt ?? (n.endsAt && n.endsAt > existing.startsAt ? n.endsAt : null),
    allDay: takeTimes ? n.allDay : existing.allDay,
    tz: takeTimes ? n.tz ?? existing.tz : existing.tz ?? n.tz,
    city: existing.city,
    country: existing.country ?? n.country,
    venue: existing.venue ?? n.venue,
    address: existing.address ?? n.address,
    lat: existing.lat ?? n.lat,
    lon: existing.lon ?? n.lon,
    category: existing.category === "other" ? n.category : existing.category,
    tags: [...new Set([...existing.tags, ...n.tags])].slice(0, MAX_TAGS),
    priceMin: hasPrice ? existing.priceMin : n.priceMin,
    priceMax: hasPrice ? existing.priceMax : n.priceMax,
    currency: existing.currency ?? n.currency,
    isFree: existing.isFree ?? n.isFree,
    url: existing.url,
    ticketUrl: existing.ticketUrl ?? n.ticketUrl,
    imageUrl: existing.imageUrl ?? n.imageUrl,
    lang: existing.lang ?? n.lang,
    // Cancelled sticks, unless the source that said so now says otherwise.
    cancelled: sameSource ? n.cancelled : existing.cancelled || n.cancelled,
    seen: seen.slice(-MAX_SEEN),
  };
}

function fuzzyKey(title: string, startsAt: string, tz: string | null, city: string): string {
  return [norm(title), localDate(startsAt, tz), norm(city)].join("|");
}

export async function upsertEvents(sql: Sql, events: ReadyEvent[], via: string, now: Date): Promise<UpsertResult> {
  const result: UpsertResult = { added: 0, updated: 0, skipped: 0 };
  if (!events.length) return result;

  const ids = events.map((e) => e.id);
  const times = events.map((e) => Date.parse(e.startsAt));
  const from = new Date(Math.min(...times) - 2 * DAY).toISOString();
  const to = new Date(Math.max(...times) + 2 * DAY).toISOString();
  const cities = [...new Set(events.map((e) => e.city.toLowerCase()))];

  return await sql.begin(async (tx) => {
    const rows = await tx`
      select * from sawk.events
      where id = any(${tx.array(ids)}::text[])
         or (lower(city) = any(${tx.array(cities)}::text[])
             and starts_at >= ${from}::timestamptz and starts_at <= ${to}::timestamptz)`;
    const byId = new Map<string, Row>();
    const byFuzzy = new Map<string, Row[]>();
    const index = (r: Row) => {
      byId.set(r.id as string, r);
      const k = fuzzyKey(r.title as string, iso(r.starts_at)!, (r.tz as string | null) ?? null, r.city as string);
      byFuzzy.set(k, [...(byFuzzy.get(k) ?? []), r]);
    };
    rows.forEach(index);

    for (const e of events) {
      let row = byId.get(e.id);
      if (!row) {
        // Same title, day and city, and one side does not know the venue: the same event.
        const cands = byFuzzy.get(fuzzyKey(e.title, e.startsAt, e.tz, e.city)) ?? [];
        row = cands.find((c) => !c.venue || !e.venue);
      }
      if (!row && e.cancelled) {
        result.skipped++;
        continue;
      }
      const merged = mergeEvent(row ? fromRow(row) : null, e, via, now);
      if (row) {
        await update(tx, row.id as string, merged, now);
        result.updated++;
        index({ ...row, ...toRow(row.id as string, merged) });
      } else {
        await insert(tx, e.id, merged, now);
        result.added++;
        index(toRow(e.id, merged));
      }
    }
    return result;
  });
}

function toRow(id: string, m: Merged): Row {
  return {
    id,
    title: m.title,
    starts_at: m.startsAt,
    tz: m.tz,
    city: m.city,
    venue: m.venue,
    seen: m.seen,
  };
}

async function insert(tx: Sql, id: string, m: Merged, now: Date) {
  await tx`
    insert into sawk.events (id, title, description, starts_at, ends_at, all_day, tz, city, country, venue, address, lat, lon,
      category, tags, price_min, price_max, currency, is_free, url, ticket_url, image_url, lang, cancelled, seen,
      first_seen_at, last_seen_at)
    values (${id}, ${m.title}, ${m.description}, ${m.startsAt}::timestamptz, ${m.endsAt}::timestamptz, ${m.allDay}, ${m.tz},
      ${m.city}, ${m.country}, ${m.venue}, ${m.address}, ${m.lat}::double precision, ${m.lon}::double precision,
      ${m.category}, ${
    tx.array(m.tags)
  }::text[], ${m.priceMin}::numeric, ${m.priceMax}::numeric, ${m.currency}, ${m.isFree}::boolean,
      ${m.url}, ${m.ticketUrl}, ${m.imageUrl}, ${m.lang}, ${m.cancelled}, ${tx.json(m.seen)}::jsonb,
      ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
    on conflict (id) do nothing`;
}

async function update(tx: Sql, id: string, m: Merged, now: Date) {
  await tx`
    update sawk.events set
      description = ${m.description}, starts_at = ${m.startsAt}::timestamptz, ends_at = ${m.endsAt}::timestamptz,
      all_day = ${m.allDay}, tz = ${m.tz}, country = ${m.country}, venue = ${m.venue}, address = ${m.address},
      lat = ${m.lat}::double precision, lon = ${m.lon}::double precision, category = ${m.category},
      tags = ${tx.array(m.tags)}::text[], price_min = ${m.priceMin}::numeric, price_max = ${m.priceMax}::numeric,
      currency = ${m.currency}, is_free = ${m.isFree}::boolean, ticket_url = ${m.ticketUrl}, image_url = ${m.imageUrl},
      lang = ${m.lang}, cancelled = ${m.cancelled}, seen = ${
    tx.json(m.seen)
  }::jsonb, last_seen_at = ${now.toISOString()}::timestamptz
    where id = ${id}`;
}
