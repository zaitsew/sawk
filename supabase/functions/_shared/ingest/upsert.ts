// Writing events to sawk.events. The same concert from two sources lands on
// one row: by id when title, local date, venue and city agree; by title, date
// and city when one of the two sightings has no venue; and by the title's core
// (what is left once a listing's " en <venue>, <city> 2026" is stripped) on the
// same local day. Fields merge richer-wins; nothing a person or an agent wrote
// is blanked.

import type { Row, Sql } from "../db.ts";
import { localDate, norm } from "../ids.ts";
import { DAY } from "./time.ts";
import type { ReadyEvent } from "./normalize.ts";

export interface Sighting {
  via: string;
  url: string;
  at: string;
  /** This source reported the event cancelled. Only a source that did can un-cancel it. */
  cancelled?: true;
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
  if (n.cancelled) sighting.cancelled = true;
  if (!existing) return { ...n, seen: [sighting] };

  const sameSource = existing.seen.some((s) => s.via === via);
  // Times: the source that saw it before is the authority on a change; otherwise a timed reading beats an all-day one.
  const takeTimes = sameSource || (existing.allDay && !n.allDay);

  // Sightings. A source that now says "not cancelled" drops its own cancellation flag, nobody else's.
  const flaggedBefore = existing.seen.some((s) => s.cancelled);
  const seen = existing.seen
    .filter((s) => s.url !== sighting.url || s.via !== via)
    .map((s) => (s.via === via && !n.cancelled && s.cancelled ? { via: s.via, url: s.url, at: s.at } : s));
  seen.push(sighting);
  // Stays cancelled if this source says so; or if it was cancelled and a source that cancelled it still stands,
  // or nobody on record cancelled it (an agent or an older row): a feed cannot undo that.
  const cancelled = n.cancelled || (existing.cancelled && (seen.some((s) => s.cancelled) || !flaggedBefore));
  while (seen.length > MAX_SEEN) seen.splice(Math.max(0, seen.findIndex((s) => !s.cancelled)), 1);

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
    cancelled,
    seen,
  };
}

function fuzzyKey(title: string, startsAt: string, tz: string | null, city: string): string {
  return [norm(title), localDate(startsAt, tz), norm(city)].join("|");
}

function dayKey(startsAt: string, tz: string | null, city: string): string {
  return [localDate(startsAt, tz), norm(city)].join("|");
}

// ---- title variants ------------------------------------------------------
// Listing sites dress the act's name with where and when: "Francisca Valenzuela en Loco Club, Valencia 2026",
// "Morat Valencia Tickets", "ABHIR in València". Songkick says "Francisca Valenzuela". The core is the act.

/** Venue words that say what kind of place it is, not which one. */
const GENERIC_VENUE = new Set([
  "sala",
  "teatro",
  "teatre",
  "theatre",
  "theater",
  "auditorio",
  "auditori",
  "auditorium",
  "club",
  "bar",
  "centro",
  "centre",
  "center",
  "espacio",
  "espai",
  "palau",
  "palacio",
  "del",
  "dels",
  "and",
]);

const words = (s: string) => s.split(" ").filter(Boolean);

/** The words that name this venue: "Auditorio - Roig Arena" -> roig, arena. */
function venueWords(venue: string | null | undefined, city: string): Set<string> {
  const c = new Set(words(norm(city)));
  return new Set(words(norm(venue)).filter((w) => w.length >= 3 && !GENERIC_VENUE.has(w) && !c.has(w)));
}

/** The title without the city, a trailing year, "tickets", or " en <this venue>". Words as `norm` makes them. */
export function coreTitle(title: string, venue: string | null | undefined, city: string): string {
  const c = norm(city);
  let t = ` ${norm(title)} `;
  if (c) { while (t.includes(` ${c} `)) t = t.replace(` ${c} `, " "); }
  t = t.trim();
  const place = venueWords(venue, city);
  for (let prev = ""; prev !== t;) {
    prev = t;
    t = t.replace(/ (?:19|20)\d\d$/, "").replace(/ (?:tickets?|entradas?|billets?)$/, "").replace(/ (?:in|en|at)$/, "");
    const cut = t.lastIndexOf(" en ");
    if (cut > 0 && words(t.slice(cut + 4)).some((w) => place.has(w))) t = t.slice(0, cut);
  }
  return t;
}

/** Two venue names for one place: one unknown, one inside the other, or a naming word in common. */
export function sameVenue(a: string | null | undefined, b: string | null | undefined, city: string): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = venueWords(a, city);
  return [...venueWords(b, city)].some((w) => wa.has(w));
}

export interface Sighted {
  title: string;
  venue: string | null;
  city: string;
  startsAt: string;
  allDay: boolean;
}

const PREFIX_MIN = 4;
const PREFIX_HOURS = 3;

/**
 * The candidate (same local day and city) that is `e` under another title, or undefined.
 * Equal cores at the same venue match. Otherwise one core may be the other's first words ("Michel Camilo",
 * "Michel Camilo Trio") when it is the only such candidate and, if both are timed, they start within 3 hours:
 * "Digital Jove 2026" next to two of its workshops matches neither.
 */
export function variantOf<T extends Sighted>(e: Sighted, cands: T[]): T | undefined {
  const core = coreTitle(e.title, e.venue, e.city);
  if (core.length < 3) return undefined;
  const here = cands.filter((c) => sameVenue(c.venue, e.venue, e.city));
  const cores = here.map((c) => coreTitle(c.title, c.venue, c.city));
  const equal = here.find((_, i) => cores[i] === core);
  if (equal) return equal;
  const near = (c: T) =>
    c.allDay || e.allDay || Math.abs(Date.parse(c.startsAt) - Date.parse(e.startsAt)) <= PREFIX_HOURS * 3_600_000;
  const prefixed = here.filter((c, i) => {
    const [short, long] = cores[i].length < core.length ? [cores[i], core] : [core, cores[i]];
    return short.length >= PREFIX_MIN && long.startsWith(short + " ") && near(c);
  });
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

const sightedOf = (r: Row): Sighted => ({
  title: r.title as string,
  venue: (r.venue as string | null) ?? null,
  city: r.city as string,
  startsAt: iso(r.starts_at)!,
  allDay: r.all_day === true,
});

export async function upsertEvents(sql: Sql, events: ReadyEvent[], via: string, now: Date): Promise<UpsertResult> {
  const result: UpsertResult = { added: 0, updated: 0, skipped: 0 };
  if (!events.length) return result;

  const ids = events.map((e) => e.id);
  const times = events.map((e) => Date.parse(e.startsAt));
  const from = new Date(Math.min(...times) - 2 * DAY).toISOString();
  const to = new Date(Math.max(...times) + 2 * DAY).toISOString();
  const cities = [...new Set(events.map((e) => e.city.toLowerCase()))];

  return await sql.begin(async (tx) => {
    // The first read only finds candidates. A row is read again, locked, right before it is merged and
    // written, so a field another writer (an agent, another run) filled in meanwhile is merged, not overwritten.
    const rows = await tx`
      select * from sawk.events
      where id = any(${tx.array(ids)}::text[])
         or (lower(city) = any(${tx.array(cities)}::text[])
             and starts_at >= ${from}::timestamptz and starts_at <= ${to}::timestamptz)`;
    const byId = new Map<string, Row>();
    const byFuzzy = new Map<string, Row[]>();
    const byDay = new Map<string, Row[]>();
    const keyOf = (r: Row) =>
      fuzzyKey(r.title as string, iso(r.starts_at)!, (r.tz as string | null) ?? null, r.city as string);
    const dayOf = (r: Row) => dayKey(iso(r.starts_at)!, (r.tz as string | null) ?? null, r.city as string);
    const index = (r: Row) => {
      const old = byId.get(r.id as string);
      if (old) {
        byFuzzy.set(keyOf(old), (byFuzzy.get(keyOf(old)) ?? []).filter((x) => x.id !== r.id));
        byDay.set(dayOf(old), (byDay.get(dayOf(old)) ?? []).filter((x) => x.id !== r.id));
      }
      byId.set(r.id as string, r);
      byFuzzy.set(keyOf(r), [...(byFuzzy.get(keyOf(r)) ?? []), r]);
      byDay.set(dayOf(r), [...(byDay.get(dayOf(r)) ?? []), r]);
    };
    rows.forEach(index);

    const lock = async (id: string): Promise<Row | null> =>
      (await tx`select * from sawk.events where id = ${id}::text for update`)[0] ?? null;
    const write = async (row: Row, e: ReadyEvent) => {
      const merged = mergeEvent(fromRow(row), e, via, now);
      await update(tx, row.id as string, merged, now);
      result.updated++;
      index(rowOf(row.id as string, merged));
    };

    for (const e of events) {
      let hit = byId.get(e.id);
      if (!hit) {
        // Same title, day and city, and one side does not know the venue: the same event.
        const cands = byFuzzy.get(fuzzyKey(e.title, e.startsAt, e.tz, e.city)) ?? [];
        hit = cands.find((c) => !c.venue || !e.venue);
      }
      if (!hit) {
        // The same act on the same day under a listing's longer title.
        const day = byDay.get(dayKey(e.startsAt, e.tz, e.city)) ?? [];
        hit = variantOf({ ...e, venue: e.venue ?? null }, day.map((r) => ({ ...sightedOf(r), row: r })))?.row;
      }
      const row = hit ? await lock(hit.id as string) : null;
      if (row) {
        await write(row, e);
        continue;
      }
      if (e.cancelled) {
        result.skipped++;
        continue;
      }
      const merged = mergeEvent(null, e, via, now);
      if (await insert(tx, e.id, merged, now)) {
        result.added++;
        index(rowOf(e.id, merged));
      } else {
        // Someone inserted it between our read and our write: merge into theirs.
        const theirs = await lock(e.id);
        if (theirs) await write(theirs, e);
      }
    }
    return result;
  });
}

/** Two stored rows of one event folded into the first: fields richer-wins, every sighting kept. */
export function foldEvents(keep: Merged, dup: Merged): Merged {
  const timesFromDup = keep.allDay && !dup.allDay;
  const seen = [...keep.seen];
  for (const s of dup.seen) if (!seen.some((x) => x.via === s.via && x.url === s.url)) seen.push(s);
  while (seen.length > MAX_SEEN) seen.splice(Math.max(0, seen.findIndex((s) => !s.cancelled)), 1);
  const hasPrice = keep.priceMin !== null || keep.priceMax !== null;
  return {
    ...keep,
    description: (dup.description?.length ?? 0) > (keep.description?.length ?? 0) ? dup.description : keep.description,
    startsAt: timesFromDup ? dup.startsAt : keep.startsAt,
    endsAt: timesFromDup ? dup.endsAt : keep.endsAt,
    allDay: timesFromDup ? dup.allDay : keep.allDay,
    tz: timesFromDup ? dup.tz ?? keep.tz : keep.tz ?? dup.tz,
    country: keep.country ?? dup.country,
    venue: keep.venue ?? dup.venue,
    address: keep.address ?? dup.address,
    lat: keep.lat ?? dup.lat,
    lon: keep.lon ?? dup.lon,
    category: keep.category === "other" ? dup.category : keep.category,
    tags: [...new Set([...keep.tags, ...dup.tags])].slice(0, MAX_TAGS),
    priceMin: hasPrice ? keep.priceMin : dup.priceMin,
    priceMax: hasPrice ? keep.priceMax : dup.priceMax,
    currency: keep.currency ?? dup.currency,
    isFree: keep.isFree ?? dup.isFree,
    ticketUrl: keep.ticketUrl ?? dup.ticketUrl,
    imageUrl: keep.imageUrl ?? dup.imageUrl,
    lang: keep.lang ?? dup.lang,
    seen,
  };
}

/**
 * Rows already stored twice under title variants (before this rule existed, or added by agents, who match by id
 * only) become one: the person's state, rating, an agent's rank and the feedback move to the row that stays.
 * The row that stays has the plainest title ("Francisca Valenzuela" over "... en Loco Club, Valencia 2026"),
 * then a start time, then the earliest sighting. Upcoming, not cancelled events only. Returns how many rows went.
 */
export async function collapseDuplicates(sql: Sql, now: Date): Promise<number> {
  return await sql.begin(async (tx) => {
    const rows = await tx`
      select * from sawk.events
      where not cancelled and coalesce(ends_at, starts_at) >= ${now.toISOString()}::timestamptz - interval '6 hours'
      order by id for update`;
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = dayKey(iso(r.starts_at)!, (r.tz as string | null) ?? null, r.city as string);
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const plain = (r: Row) =>
      coreTitle(r.title as string, r.venue as string | null, r.city as string) === norm(r.title as string);
    let gone = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) =>
        Number(plain(b)) - Number(plain(a)) || Number(a.all_day === true) - Number(b.all_day === true) ||
        Date.parse(iso(a.first_seen_at)!) - Date.parse(iso(b.first_seen_at)!) || ((a.id as string) < (b.id as string) ? -1 : 1)
      );
      const kept: { row: Row; merged: Merged; s: Sighted }[] = [];
      for (const r of group) {
        const k = variantOf(sightedOf(r), kept.map((x) => x.s));
        const into = k && kept.find((x) => x.s === k);
        if (!into) {
          kept.push({ row: r, merged: fromRow(r), s: sightedOf(r) });
          continue;
        }
        const keepId = into.row.id as string, dupId = r.id as string;
        into.merged = foldEvents(into.merged, fromRow(r));
        await update(tx, keepId, into.merged, now);
        // The person's own rows: one only on the duplicate moves; on both, the stronger state and an agent's rank win.
        await tx`
          update sawk.feed k set
            state = case when k.state = 'new' then d.state else k.state end,
            rating = coalesce(k.rating, d.rating),
            score = case when k.ranked_by = 'fallback' and d.ranked_by <> 'fallback' then d.score else k.score end,
            reason = case when k.ranked_by = 'fallback' and d.ranked_by <> 'fallback' then d.reason else k.reason end,
            ranked_at = case when k.ranked_by = 'fallback' and d.ranked_by <> 'fallback' then d.ranked_at else k.ranked_at end,
            ranked_by = case when k.ranked_by = 'fallback' and d.ranked_by <> 'fallback' then d.ranked_by else k.ranked_by end,
            updated_at = ${now.toISOString()}::timestamptz
          from sawk.feed d
          where k.event_id = ${keepId} and d.event_id = ${dupId} and d.user_id = k.user_id`;
        await tx`
          update sawk.feed f set event_id = ${keepId}
          where f.event_id = ${dupId}
            and not exists (select 1 from sawk.feed g where g.user_id = f.user_id and g.event_id = ${keepId})`;
        await tx`update sawk.feedback set event_id = ${keepId} where event_id = ${dupId}`;
        await tx`delete from sawk.events where id = ${dupId}`;
        gone++;
      }
    }
    return gone;
  });
}

/** A merged event in the shape of a `sawk.events` row, for the in-batch cache. Every column `fromRow` reads. */
function rowOf(id: string, m: Merged): Row {
  return {
    id,
    title: m.title,
    description: m.description,
    starts_at: m.startsAt,
    ends_at: m.endsAt,
    all_day: m.allDay,
    tz: m.tz,
    city: m.city,
    country: m.country,
    venue: m.venue,
    address: m.address,
    lat: m.lat,
    lon: m.lon,
    category: m.category,
    tags: m.tags,
    price_min: m.priceMin,
    price_max: m.priceMax,
    currency: m.currency,
    is_free: m.isFree,
    url: m.url,
    ticket_url: m.ticketUrl,
    image_url: m.imageUrl,
    lang: m.lang,
    cancelled: m.cancelled,
    seen: m.seen,
  };
}

async function insert(tx: Sql, id: string, m: Merged, now: Date): Promise<boolean> {
  const rows = await tx`
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
    on conflict (id) do nothing returning id`;
  return rows.length > 0;
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
