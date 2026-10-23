// The fallback rank: a rule-based score per (person, event), so the feed is
// never empty while no agent has ranked. It is written with ranked_by =
// 'fallback' and only where no agent (or the person) has a rank for the event.
// No model, no network; the inputs are the profile, the person's history in
// sawk.feedback, Loco's busy days, and the event itself.

import type { Row, Sql } from "./db.ts";
import { localDate } from "./ids.ts";
import { fold, sameCity } from "./ingest/normalize.ts";
import { addDays, DAY, defaultTz, isValidTz, todayIn } from "./ingest/time.ts";

export const HORIZON_DAYS = 14;
export const BASE = 0.3;

export interface ScoreEvent {
  title: string;
  category: string;
  tags: string[];
  venue: string | null;
  city: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  isFree: boolean | null;
}

export interface ScoreProfile {
  likes: string[];
  avoids: string[];
  priceMax: number | null;
  currency: string;
}

export interface Tally {
  saved: number; // saved or going
  went: number; // went, or rated well
  neg: number; // hidden, or rated badly
}

export interface History {
  byCategory: Map<string, Tally>;
  byVenue: Map<string, Tally>;
}

export interface Busy {
  day: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface Scored {
  score: number;
  reason: string;
}

// ---- text matching -------------------------------------------------------

const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const stemmed = (s: string) => fold(s).split(" ").filter(Boolean).map(stem);

interface Match {
  term: string;
  strength: number;
}

/** How well `term` (a profile tag such as "tech meetups") matches the words of an event. 0 for none. */
export function matchStrength(term: string, textWords: string[]): number {
  const words = stemmed(term).filter((w) => w.length >= 3 || /\d/.test(w));
  if (!words.length || fold(term).length < 3) return 0;
  const padded = ` ${textWords.join(" ")} `;
  if (padded.includes(` ${words.join(" ")} `)) return 1;
  if (words.length >= 2 && words.every((w) => textWords.includes(w))) return 0.8;
  return 0;
}

function textOf(ev: ScoreEvent): string[] {
  return stemmed([ev.title, ev.tags.join(" "), ev.category, ev.venue ?? ""].join(" "));
}

function matches(terms: string[], words: string[]): Match[] {
  return terms
    .map((term) => ({ term, strength: matchStrength(term, words) }))
    .filter((m) => m.strength > 0)
    .sort((a, b) => b.strength - a.strength);
}

// ---- the score -----------------------------------------------------------

interface Factor {
  delta: number;
  text: string;
  positive: boolean;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function emptyHistory(): History {
  return { byCategory: new Map(), byVenue: new Map() };
}

/** `day` is the local date (YYYY-MM-DD) the event is shown on. */
export function scoreEvent(ev: ScoreEvent, profile: ScoreProfile, history: History, busy: Busy[], day: string): Scored {
  const words = textOf(ev);
  const factors: Factor[] = [];
  let score = BASE;

  const liked = matches(profile.likes, words);
  if (liked.length) {
    const boost = Math.min(0.45, 0.3 * liked[0].strength + liked.slice(1).reduce((s, m) => s + 0.1 * m.strength, 0));
    score += boost;
    factors.push({ delta: boost, text: `Matches '${liked[0].term}'`, positive: true });
  }

  const cat = history.byCategory.get(ev.category);
  if (cat) {
    const good = cat.saved + cat.went;
    if (good > 0) {
      const boost = Math.min(0.2, 0.05 * good);
      score += boost;
      const verb = cat.saved === 0 ? "enjoyed" : "saved";
      factors.push({ delta: boost, text: `you've ${verb} ${plural(good, `${ev.category} event`)}`, positive: true });
    }
    if (cat.neg > 0) {
      const pen = Math.min(0.25, 0.06 * cat.neg);
      score -= pen;
      factors.push({ delta: -pen, text: `You've hidden ${plural(cat.neg, `${ev.category} event`)}`, positive: false });
    }
  }
  const ven = ev.venue ? history.byVenue.get(fold(ev.venue)) : undefined;
  if (ven) {
    if (ven.saved + ven.went > 0) score += 0.05;
    if (ven.neg > 0) {
      score -= 0.2;
      factors.push({ delta: -0.2, text: `You hid events at ${ev.venue}`, positive: false });
    }
  }

  const price = ev.priceMin ?? ev.priceMax;
  if (
    profile.priceMax !== null && price !== null && price > profile.priceMax &&
    (!ev.currency || ev.currency.toUpperCase() === profile.currency.toUpperCase())
  ) {
    const pen = price > 2 * profile.priceMax ? 0.35 : 0.25;
    score -= pen;
    factors.push({ delta: -pen, text: `Over your ${profile.priceMax} ${profile.currency} limit`, positive: false });
  }

  const free = ev.isFree === true;
  if (free) score += 0.05;

  const dayBusy = busy.filter((b) => b.day === day);
  if (dayBusy.length) {
    const start = Date.parse(ev.startsAt);
    const end = ev.endsAt ? Date.parse(ev.endsAt) : start + 2 * 3_600_000;
    const overlaps = !ev.allDay && dayBusy.some((b) => {
      if (!b.startsAt) return false;
      const bs = Date.parse(b.startsAt);
      const be = b.endsAt ? Date.parse(b.endsAt) : bs + 2 * 3_600_000;
      return bs < end && start < be;
    });
    const pen = overlaps ? 0.25 : 0.08;
    score -= pen;
    factors.push({
      delta: -pen,
      text: overlaps ? "You have something on at that time" : "You already have plans that day",
      positive: false,
    });
  }

  const avoided = matches(profile.avoids, words)[0];
  let reason: string;
  if (avoided) {
    score = Math.min(score * 0.2, 0.15);
    reason = `Avoided: '${avoided.term}'.`;
  } else {
    const top = [...factors].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    if (top && top.positive) {
      reason = free
        ? top.text.startsWith("Matches") ? `${top.text}, and it's free.` : `Free, and ${top.text}.`
        : `${top.text[0].toUpperCase()}${top.text.slice(1)}.`;
    } else if (top) {
      reason = `${top.text}.`;
    } else if (free) {
      reason = "Free to attend.";
    } else {
      reason = `${ev.category[0].toUpperCase()}${ev.category.slice(1)} in ${ev.city}.`;
    }
  }
  return { score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000, reason };
}

// ---- windows -------------------------------------------------------------

export interface DayPlace {
  city: string;
  country: string | null;
  tz: string | null;
  /** sawk.city_key(city): "Валенсия" and "Valencia" share one. Without it, names are compared. */
  key?: string | null;
}

export interface WindowRow extends DayPlace {
  from: string;
  to: string;
}

/** Where the person is on each day from `from` for `days` days: home, overridden by trip windows (later ones win). */
export function dayPlaces(home: DayPlace, windows: WindowRow[], from: string, days: number): Map<string, DayPlace> {
  const out = new Map<string, DayPlace>();
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    let place = home;
    for (const w of windows) if (w.from <= d && d <= w.to) place = w;
    out.set(d, { city: place.city, country: place.country, tz: place.tz ?? home.tz, key: place.key ?? null });
  }
  return out;
}

export interface Candidate {
  id: string;
  event: ScoreEvent;
  tz: string | null;
  day: string;
}

/**
 * The days an event can be shown on: those it spans, in a city the person is in. The earliest is its day.
 * Returns null when the event is over, or the person is never in its city.
 */
export function assignDay(
  ev: ScoreEvent & { tz: string | null; cityKey?: string | null },
  places: Map<string, DayPlace>,
  now: Date,
): string | null {
  const start = Date.parse(ev.startsAt);
  const over = ev.endsAt ? Date.parse(ev.endsAt) : start + (ev.allDay ? DAY : 3 * 3_600_000);
  if (isNaN(start) || over < now.getTime()) return null;
  const tzOf = (d: string) => (isValidTz(ev.tz) ? ev.tz : places.get(d)?.tz ?? null);
  for (const [d, place] of places) {
    if (!(place.key && ev.cityKey ? place.key === ev.cityKey : sameCity(place.city, ev.city))) continue;
    const tz = tzOf(d);
    const s = localDate(ev.startsAt, tz);
    const e = ev.endsAt ? localDate(new Date(Date.parse(ev.endsAt) - 1000).toISOString(), tz) : s;
    if (s <= d && d <= (e < s ? s : e)) return d;
  }
  return null;
}

// ---- the writer ----------------------------------------------------------

export interface FallbackResult {
  users: number;
  ranked: number;
  pruned: number;
  errors: string[];
}

const asNum = (v: unknown): number | null => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));

async function loadHistory(sql: Sql, userId: string, now: Date): Promise<History> {
  const rows = await sql`
    select distinct on (f.event_id) f.action, f.rating, e.category, e.venue
    from sawk.feedback f join sawk.events e on e.id = f.event_id
    where f.user_id = ${userId}::uuid and f.at > ${now.toISOString()}::timestamptz - interval '90 days'
    order by f.event_id, f.at desc, f.id desc`;
  const h = emptyHistory();
  const bump = (m: Map<string, Tally>, key: string, field: keyof Tally) => {
    if (!key) return;
    const t = m.get(key) ?? { saved: 0, went: 0, neg: 0 };
    t[field]++;
    m.set(key, t);
  };
  for (const r of rows) {
    const rating = asNum(r.rating);
    let field: keyof Tally | null = null;
    switch (r.action) {
      case "save":
      case "going":
        field = "saved";
        break;
      case "went":
      case "rate":
        field = rating === null
          ? (r.action === "went" ? "went" : null)
          : rating > 0
          ? "went"
          : rating < 0
          ? "neg"
          : null;
        break;
      case "hide":
        field = "neg";
        break;
    }
    if (!field) continue;
    bump(h.byCategory, r.category as string, field);
    bump(h.byVenue, fold(r.venue as string | null), field);
  }
  return h;
}

/** Writes fallback ranks for every person with a profile. One person failing does not stop the others. */
export async function writeFallbackRanks(sql: Sql, now: Date): Promise<FallbackResult> {
  const result: FallbackResult = { users: 0, ranked: 0, pruned: 0, errors: [] };
  const profiles = await sql`
    select user_id, home_city, home_country, home_tz, likes, avoids, price_max, currency, max_per_day from sawk.profiles`;
  for (const p of profiles) {
    try {
      const r = await rankUser(sql, p, now);
      if (r) {
        result.users++;
        result.ranked += r.ranked;
        result.pruned += r.pruned;
      }
    } catch (e) {
      result.errors.push(`${p.user_id}: ${(e as Error).message}`);
    }
  }
  return result;
}

async function rankUser(sql: Sql, p: Row, now: Date): Promise<{ ranked: number; pruned: number } | null> {
  const userId = p.user_id as string;
  let home: DayPlace | null = p.home_city
    ? {
      city: p.home_city as string,
      country: (p.home_country as string | null) ?? null,
      tz: (p.home_tz as string | null) ?? null,
    }
    : null;
  if (!home) {
    const [loco] = await sql`select city, country, tz from sawk.loco_home(${userId}::uuid)`;
    if (loco?.city) {
      home = {
        city: loco.city as string,
        country: (loco.country as string | null) ?? null,
        tz: (loco.tz as string | null) ?? null,
      };
    }
  }
  if (!home) return null; // nowhere to rank for
  home.tz = isValidTz(home.tz) ? home.tz : defaultTz(home.city, home.country);
  home.key = (await sql`select sawk.city_key(${home.city}::text) as k`)[0].k as string;

  const from = todayIn(now, home.tz);
  const to = addDays(from, HORIZON_DAYS - 1);
  const manual = await sql`
    select city, sawk.city_key(city) as key, country, tz, starts_on::text as f, ends_on::text as t from sawk.windows
    where user_id = ${userId}::uuid and ends_on >= ${from}::date and starts_on <= ${to}::date order by starts_on`;
  const loco = await sql`
    select city, sawk.city_key(city) as key, country, tz, starts_on::text as f, ends_on::text as t from sawk.loco_windows(${userId}::uuid, ${from}::date, ${to}::date)`;
  const windows: WindowRow[] = [...manual, ...loco].map((w) => ({
    city: w.city as string,
    key: (w.key as string | null) ?? null,
    country: (w.country as string | null) ?? null,
    tz: (w.tz as string | null) ?? null,
    from: w.f as string,
    to: w.t as string,
  }));
  const places = dayPlaces(home, windows, from, HORIZON_DAYS);

  const winFrom = new Date(Date.parse(from + "T00:00:00Z") - DAY).toISOString();
  const winTo = new Date(Date.parse(to + "T00:00:00Z") + 2 * DAY).toISOString();
  const events = await sql`
    select id, title, starts_at, ends_at, all_day, tz, city, city_key, venue, category, tags, price_min, price_max, currency, is_free
    from sawk.events
    where not cancelled and starts_at < ${winTo}::timestamptz
      and coalesce(ends_at, starts_at + interval '3 hours') >= ${winFrom}::timestamptz`;

  const history = await loadHistory(sql, userId, now);
  const busyRows =
    await sql`select day::text as day, starts_at, ends_at from sawk.loco_busy(${userId}::uuid, ${from}::date, ${to}::date)`;
  const busy: Busy[] = busyRows.map((b) => ({
    day: b.day as string,
    startsAt: b.starts_at ? new Date(b.starts_at as string).toISOString() : null,
    endsAt: b.ends_at ? new Date(b.ends_at as string).toISOString() : null,
  }));

  const profile: ScoreProfile = {
    likes: (p.likes as string[]) ?? [],
    avoids: (p.avoids as string[]) ?? [],
    priceMax: asNum(p.price_max),
    currency: (p.currency as string | null) ?? "EUR",
  };

  // Which of them already have a rank that is not ours?
  const ids = events.map((e) => e.id as string);
  const existing = ids.length
    ? await sql`select event_id, ranked_by from sawk.feed where user_id = ${userId}::uuid and event_id = any(${
      sql.array(ids)
    }::text[])`
    : [];
  const taken = new Set(existing.filter((r) => r.ranked_by !== "fallback").map((r) => r.event_id as string));

  const byDay = new Map<string, (Candidate & Scored & { startMs: number })[]>();
  for (const r of events) {
    if (taken.has(r.id as string)) continue;
    const ev: ScoreEvent & { tz: string | null; cityKey: string | null } = {
      title: r.title as string,
      category: r.category as string,
      tags: (r.tags as string[]) ?? [],
      venue: (r.venue as string | null) ?? null,
      city: r.city as string,
      startsAt: new Date(r.starts_at as string).toISOString(),
      endsAt: r.ends_at ? new Date(r.ends_at as string).toISOString() : null,
      allDay: r.all_day === true,
      priceMin: asNum(r.price_min),
      priceMax: asNum(r.price_max),
      currency: (r.currency as string | null) ?? null,
      isFree: (r.is_free as boolean | null) ?? null,
      tz: (r.tz as string | null) ?? null,
      cityKey: (r.city_key as string | null) ?? null,
    };
    const day = assignDay(ev, places, now);
    if (!day) continue;
    const s = scoreEvent(ev, profile, history, busy, day);
    const list = byDay.get(day) ?? [];
    list.push({ id: r.id as string, event: ev, tz: ev.tz, day, startMs: Date.parse(ev.startsAt), ...s });
    byDay.set(day, list);
  }

  const perDay = Math.max(1, Number(p.max_per_day ?? 3)) * 3;
  const keep: (Candidate & Scored)[] = [];
  const candidateIds: string[] = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => b.score - a.score || a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
    keep.push(...list.slice(0, perDay));
    candidateIds.push(...list.map((c) => c.id));
  }

  const at = now.toISOString();
  let pruned = 0;
  await sql.begin(async (tx) => {
    for (const k of keep) {
      await tx`
        insert into sawk.feed (user_id, event_id, score, reason, ranked_by, ranked_at, updated_at)
        values (${userId}::uuid, ${k.id}, ${k.score}::real, ${k.reason}, 'fallback', ${at}::timestamptz, ${at}::timestamptz)
        on conflict (user_id, event_id) do update
          set score = excluded.score, reason = excluded.reason, ranked_at = excluded.ranked_at, updated_at = excluded.updated_at
          where sawk.feed.ranked_by = 'fallback'`;
    }
    // Fallback rows nobody acted on that fell out of the top N, or whose event was cancelled, go.
    const keepIds = keep.map((k) => k.id);
    const gone = await tx`
      delete from sawk.feed
      where user_id = ${userId}::uuid and ranked_by = 'fallback' and state = 'new' and rating is null
        and ((event_id = any(${tx.array(candidateIds)}::text[]) and not (event_id = any(${tx.array(keepIds)}::text[])))
             or event_id in (select id from sawk.events where cancelled))
      returning event_id`;
    pruned = gone.length;
  });
  return { ranked: keep.length, pruned };
}
