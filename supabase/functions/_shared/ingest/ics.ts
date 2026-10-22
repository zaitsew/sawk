// RFC 5545 reader for the part of iCalendar that event feeds use: line
// unfolding and escapes, DTSTART/DTEND/DURATION in UTC, floating, TZID and
// all-day forms, STATUS:CANCELLED, EXDATE and RECURRENCE-ID, and RRULE
// expansion for the next 60 days (DAILY, WEEKLY, MONTHLY; INTERVAL, COUNT,
// UNTIL, BYDAY, BYMONTHDAY). Any other rule is read as a single event.

import { fetchText } from "./http.ts";
import { cleanText, isHttpUrl, looksLikeAddress, resolveUrl } from "./normalize.ts";
import { DAY, defaultTz, instantToWall, isoInstant, isValidTz, wallParts, wallToInstant } from "./time.ts";
import type { Adapter, AdapterCtx, IngestEvent, SourceRow } from "./types.ts";

export const RRULE_HORIZON_DAYS = 60;
const MAX_EVENTS = 3000;

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

// ---- lines ---------------------------------------------------------------

export function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

function parseLine(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = "";
  inQuote = false;
  for (const c of head) {
    if (c === '"') inQuote = !inQuote;
    if (c === ";" && !inQuote) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0].toUpperCase(), params, value };
}

export function unescapeText(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

// ---- dates ---------------------------------------------------------------

interface DateVal {
  wall: number;
  kind: "date" | "floating" | "utc" | "zoned";
  tz: string | null;
}

function parseDate(p: Prop): DateVal | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (isNaN(wall)) return null;
  if (m[4] === undefined || p.params["VALUE"] === "DATE") return { wall, kind: "date", tz: null };
  if (m[7]) return { wall, kind: "utc", tz: null };
  const tz = p.params["TZID"];
  return tz ? { wall, kind: "zoned", tz } : { wall, kind: "floating", tz: null };
}

function instantOf(d: DateVal, fallbackTz: string | null): number {
  if (d.kind === "utc") return d.wall;
  const tz = d.kind === "zoned" && isValidTz(d.tz) ? d.tz : fallbackTz;
  return wallToInstant(d.wall, tz);
}

export function parseDuration(s: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim());
  if (!m) return null;
  const ms = ((+(m[2] ?? 0)) * 7 + +(m[3] ?? 0)) * DAY + (+(m[4] ?? 0)) * 3_600_000 + (+(m[5] ?? 0)) * 60_000 +
    (+(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

// ---- recurrence ----------------------------------------------------------

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  count: number | null;
  until: DateVal | null;
  byDay: { ord: number; wd: number }[]; // wd: 0 = Monday
  byMonthDay: number[];
}

/** null when the rule is outside what we expand. */
export function parseRule(value: string): Rule | null {
  const kv: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const freq = kv["FREQ"];
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return null;
  for (const k of ["BYSETPOS", "BYMONTH", "BYYEARDAY", "BYWEEKNO", "BYHOUR", "BYMINUTE", "BYSECOND", "BYEASTER"]) {
    if (k in kv) return null;
  }
  const interval = kv["INTERVAL"] ? parseInt(kv["INTERVAL"], 10) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return null;
  const count = kv["COUNT"] ? parseInt(kv["COUNT"], 10) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  let until: DateVal | null = null;
  if (kv["UNTIL"]) {
    until = parseDate({ name: "UNTIL", params: {}, value: kv["UNTIL"] });
    if (!until) return null;
  }
  const byDay: Rule["byDay"] = [];
  if (kv["BYDAY"]) {
    for (const item of kv["BYDAY"].split(",")) {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item.trim().toUpperCase());
      if (!m) return null;
      byDay.push({ ord: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS.indexOf(m[2]) });
    }
    // An ordinal only means something in a monthly rule.
    if (freq !== "MONTHLY" && byDay.some((b) => b.ord !== 0)) return null;
  }
  const byMonthDay: number[] = [];
  if (kv["BYMONTHDAY"]) {
    if (freq !== "MONTHLY") return null;
    for (const item of kv["BYMONTHDAY"].split(",")) {
      const n = parseInt(item, 10);
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 31) return null;
      byMonthDay.push(n);
    }
  }
  if (freq === "DAILY" && byDay.length) return null;
  return { freq, interval, count, until, byDay, byMonthDay };
}

function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/**
 * Wall-clock starts of a rule from `startWall`, ascending, stopping at `limitWall`
 * (or the rule's own end). COUNT counts from DTSTART, as the RFC says.
 */
export function expandRule(
  startWall: number,
  rule: Rule,
  limitWall: number,
  untilInstant: (u: DateVal) => number,
  toInstant: (wall: number) => number,
): number[] {
  const out: number[] = [];
  const tod = ((startWall % DAY) + DAY) % DAY;
  const dayStart = startWall - tod;
  const untilMs = rule.until ? untilInstant(rule.until) : Infinity;
  let emitted = 0;

  const push = (wall: number): boolean => {
    if (wall < startWall) return true;
    if (toInstant(wall) > untilMs) return false;
    emitted++;
    if (wall <= limitWall) out.push(wall);
    return !(rule.count !== null && emitted >= rule.count);
  };

  if (rule.freq === "DAILY") {
    for (let k = 0; k < 20000; k++) {
      const wall = startWall + k * rule.interval * DAY;
      if (wall > limitWall) break;
      if (!push(wall)) break;
    }
  } else if (rule.freq === "WEEKLY") {
    const idx = (wallParts(startWall).dow + 6) % 7;
    const days = rule.byDay.length ? [...new Set(rule.byDay.map((b) => b.wd))].sort((a, b) => a - b) : [idx];
    const weekStart = dayStart - idx * DAY;
    outer: for (let w = 0; w < 5000; w++) {
      const base = weekStart + w * rule.interval * 7 * DAY;
      if (base > limitWall) break;
      for (const d of days) {
        const wall = base + d * DAY + tod;
        if (wall > limitWall && rule.count === null) continue;
        if (!push(wall)) break outer;
      }
    }
  } else {
    const s = wallParts(startWall);
    outer: for (let k = 0; k < 2000; k++) {
      const monthIndex = s.m - 1 + k * rule.interval;
      const y = s.y + Math.floor(monthIndex / 12);
      const m0 = ((monthIndex % 12) + 12) % 12;
      if (Date.UTC(y, m0, 1) > limitWall) break;
      const dim = daysInMonth(y, m0);
      // BYDAY and BYMONTHDAY together limit each other: only days in both.
      const byDayHits = new Set<number>();
      if (rule.byDay.length) {
        for (const { ord, wd } of rule.byDay) {
          const hits: number[] = [];
          for (let d = 1; d <= dim; d++) if ((new Date(Date.UTC(y, m0, d)).getUTCDay() + 6) % 7 === wd) hits.push(d);
          if (ord === 0) hits.forEach((d) => byDayHits.add(d));
          else {
            const pick = ord > 0 ? hits[ord - 1] : hits[hits.length + ord];
            if (pick) byDayHits.add(pick);
          }
        }
      }
      const monthDayHits = new Set<number>();
      for (const n of rule.byMonthDay) {
        const d = n > 0 ? n : dim + n + 1;
        if (d >= 1 && d <= dim) monthDayHits.add(d);
      }
      let days: Set<number>;
      if (rule.byDay.length && rule.byMonthDay.length) {
        days = new Set([...byDayHits].filter((d) => monthDayHits.has(d)));
      } else if (rule.byDay.length) days = byDayHits;
      else if (rule.byMonthDay.length) days = monthDayHits;
      else days = new Set(s.d <= dim ? [s.d] : []);
      for (const d of [...days].sort((a, b) => a - b)) {
        const wall = Date.UTC(y, m0, d) + tod;
        if (wall > limitWall && rule.count === null) continue;
        if (!push(wall)) break outer;
      }
    }
  }
  return out;
}

// ---- events --------------------------------------------------------------

const ONLINE = /\b(online|virtual|zoom|google meet|microsoft teams|webinar)\b/i;

export function splitLocation(raw: string): { venue: string | null; address: string | null; online: boolean } {
  const loc = cleanText(unescapeText(raw)).replace(/\s*\n\s*/g, ", ");
  if (!loc) return { venue: null, address: null, online: false };
  if (ONLINE.test(loc) || /^https?:\/\//i.test(loc)) return { venue: null, address: null, online: true };
  const paren = /^(.*?)\s*\((.+)\)$/.exec(loc);
  if (paren && paren[1]) return { venue: paren[1].trim(), address: paren[2].trim(), online: false };
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  const first = parts[0] ?? loc;
  const streetFirst = looksLikeAddress(first) || /\d/.test(first);
  if (parts.length >= 2) {
    return streetFirst
      ? { venue: null, address: parts.join(", "), online: false }
      : { venue: first, address: parts.slice(1).join(", "), online: false };
  }
  return streetFirst ? { venue: null, address: loc, online: false } : { venue: loc, address: null, online: false };
}

interface RawEvent {
  props: Map<string, Prop[]>;
}

function one(e: RawEvent, name: string): Prop | undefined {
  return e.props.get(name)?.[0];
}

export interface ParseOptions {
  now: Date;
  city: string;
  country: string | null;
  sourceUrl: string;
  /** Used for floating times and unknown TZIDs. */
  tz: string | null;
}

export function parseIcs(text: string, opts: ParseOptions): { events: IngestEvent[]; skipped: number } {
  const lines = unfold(text);
  const events: RawEvent[] = [];
  let calTz: string | null = null;
  const stack: string[] = [];
  let cur: RawEvent | null = null;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      stack.push(p.value.toUpperCase());
      if (p.value.toUpperCase() === "VEVENT" && stack.length === 2) cur = { props: new Map() };
      continue;
    }
    if (p.name === "END") {
      if (p.value.toUpperCase() === "VEVENT" && cur && stack.length === 2) {
        events.push(cur);
        cur = null;
      }
      stack.pop();
      continue;
    }
    if (stack.length === 1 && p.name === "X-WR-TIMEZONE" && isValidTz(p.value.trim())) calTz = p.value.trim();
    // Properties of the event itself, not of a nested VALARM.
    if (cur && stack.length === 2 && stack[1] === "VEVENT") {
      const list = cur.props.get(p.name) ?? [];
      list.push(p);
      cur.props.set(p.name, list);
    }
  }

  const tz = isValidTz(opts.tz) ? opts.tz : calTz;
  const nowMs = opts.now.getTime();
  const horizon = nowMs + RRULE_HORIZON_DAYS * DAY;
  const out: IngestEvent[] = [];
  let skipped = 0;

  // Overrides of single occurrences replace the occurrence the rule would generate.
  const overridden = new Set<string>();
  for (const e of events) {
    const rid = one(e, "RECURRENCE-ID");
    const uid = one(e, "UID")?.value;
    const d = rid && parseDate(rid);
    if (uid && d) overridden.add(`${uid}|${instantOf(d, tz)}`);
  }

  for (const e of events) {
    if (out.length >= MAX_EVENTS) break;
    const summary = one(e, "SUMMARY");
    const startProp = one(e, "DTSTART");
    const start = startProp && parseDate(startProp);
    if (!summary || !start) {
      skipped++;
      continue;
    }
    const allDay = start.kind === "date";
    const startMs = instantOf(start, tz);

    // Length of the event.
    let durMs: number | null = null;
    const endProp = one(e, "DTEND");
    const end = endProp && parseDate(endProp);
    const durProp = one(e, "DURATION");
    if (end) durMs = instantOf(end, tz) - startMs;
    else if (durProp) durMs = parseDuration(durProp.value);
    if (durMs !== null && durMs < 0) durMs = null;
    if (allDay && durMs === null) durMs = DAY;
    // A floating or TZID end in a different form than the start still gives the right length.

    const loc = one(e, "LOCATION");
    const place = loc ? splitLocation(loc.value) : { venue: null, address: null, online: false };
    if (place.online) {
      skipped++;
      continue;
    }
    const geo = one(e, "GEO")?.value.split(";").map(Number);
    const url = resolveUrl(unescapeText(one(e, "URL")?.value ?? ""), opts.sourceUrl) ?? opts.sourceUrl;
    const description = cleanText(unescapeText(one(e, "DESCRIPTION")?.value ?? ""), 600) || null;
    const tags: string[] = [];
    for (const c of e.props.get("CATEGORIES") ?? []) {
      for (const t of unescapeText(c.value).split(",")) if (t.trim()) tags.push(t.trim());
    }
    const attach = (e.props.get("ATTACH") ?? []).find((a) =>
      /^image\//i.test(a.params["FMTTYPE"] ?? "") && isHttpUrl(a.value)
    );
    const cancelled = one(e, "STATUS")?.value.trim().toUpperCase() === "CANCELLED";

    const base: IngestEvent = {
      title: cleanText(unescapeText(summary.value)),
      startsAt: isoInstant(startMs),
      endsAt: durMs === null ? null : isoInstant(startMs + durMs),
      allDay,
      tz: start.kind === "zoned" && isValidTz(start.tz) ? start.tz : tz ?? defaultTz(opts.city, opts.country),
      city: opts.city,
      country: opts.country,
      venue: place.venue,
      address: place.address,
      lat: geo && geo.length === 2 && geo.every(Number.isFinite) ? geo[0] : null,
      lon: geo && geo.length === 2 && geo.every(Number.isFinite) ? geo[1] : null,
      tags,
      url,
      imageUrl: attach?.value ?? null,
      description,
      cancelled,
    };

    const rrule = one(e, "RRULE");
    const rule = rrule && !one(e, "RECURRENCE-ID") ? parseRule(rrule.value) : null;
    if (!rule) {
      out.push(base);
      continue;
    }

    // Recurring: occurrences from now to the horizon.
    const uid = one(e, "UID")?.value;
    const exdates = new Set<number>();
    for (const ex of e.props.get("EXDATE") ?? []) {
      for (const v of ex.value.split(",")) {
        const d = parseDate({ ...ex, value: v });
        if (d) exdates.add(instantOf(d, tz));
      }
    }
    const zone = start.kind === "zoned" && isValidTz(start.tz) ? start.tz : tz;
    const limitWall = (isValidTz(zone) ? instantToWall(horizon, zone) : horizon) + DAY;
    const toInstant = (wall: number) => (start.kind === "utc" ? wall : wallToInstant(wall, zone));
    const walls = expandRule(
      start.wall,
      rule,
      limitWall,
      (u) => (u.kind === "date" ? toInstant(u.wall + DAY - 1) : instantOf(u, zone)),
      toInstant,
    );
    for (const wall of walls) {
      const s = toInstant(wall);
      if (s > horizon || (uid && overridden.has(`${uid}|${s}`))) continue;
      const len = durMs ?? 0;
      if (s + len < nowMs) continue;
      // An excluded occurrence is emitted as cancelled, so a row imported before the exclusion is marked.
      // (An occurrence nobody has seen is not inserted: the upsert skips cancelled events it does not know.)
      out.push({
        ...base,
        startsAt: isoInstant(s),
        endsAt: durMs === null ? null : isoInstant(s + len),
        ...(exdates.has(s) ? { cancelled: true } : {}),
      });
    }
  }
  return { events: out, skipped };
}

export const icsAdapter: Adapter = async (source: SourceRow, ctx: AdapterCtx) => {
  try {
    const res = await fetchText(ctx.fetch, source.url, { accept: "text/calendar, text/plain;q=0.8, */*;q=0.5" });
    if (!res.ok) return { events: [], error: res.error };
    if (!/BEGIN:VCALENDAR/i.test(res.text)) return { events: [], error: "not an iCalendar feed" };
    const { events } = parseIcs(res.text, {
      now: ctx.now,
      city: source.city,
      country: source.country,
      sourceUrl: source.url,
      tz: defaultTz(source.city, source.country),
    });
    return { events };
  } catch (e) {
    return { events: [], error: `ics: ${(e as Error).message}` };
  }
};
