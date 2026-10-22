import type { Event, FeedItem, FeedState, Window } from "../types";

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, opts: Intl.DateTimeFormatOptions, locale = "en-GB"): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts });
    dtfCache.set(key, f);
  }
  return f;
}

/** The browser's own zone. */
export function viewerTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function safeTz(tz: string | null | undefined, fallback: string): string {
  if (!tz) return fallback;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return fallback; }
}

/** The zone an event's wall clock is read in: its own, else the fallback. */
export function eventTz(e: Pick<Event, "tz">, fallback: string): string {
  return safeTz(e.tz, fallback);
}

/** `YYYY-MM-DD` of an instant on the wall clock of `tz`. */
export function dayKey(iso: string | number | Date, tz: string): string {
  const parts = dtf(tz, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** Hour (0–23) of an instant on the wall clock of `tz`. */
export function hourIn(iso: string | number | Date, tz: string): number {
  const h = dtf(tz, { hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).find((p) => p.type === "hour")?.value;
  return Number(h ?? 0) % 24;
}

/** `HH:mm` of an instant on the wall clock of `tz`. */
export function clock(iso: string | number | Date, tz: string): string {
  return dtf(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** Add days to a `YYYY-MM-DD` (calendar arithmetic, no zone involved). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function utcDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** "Sat 24 Oct". */
export function dayLabel(key: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(utcDate(key));
}

/** "Dec 8–21", "Dec 28 – Jan 4". */
export function rangeLabel(from: string, to: string): string {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const a = utcDate(from), b = utcDate(to);
  if (from === to) return f.format(a);
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${f.format(a)}–${b.getUTCDate()}`;
  }
  return `${f.format(a)} – ${f.format(b)}`;
}

/** What to show for an event's time: wall clock at the venue, plus the viewer's clock when it differs. */
export function timeLabel(e: Pick<Event, "startsAt" | "allDay" | "tz">, fallbackTz: string, viewer: string = viewerTz()): string {
  if (e.allDay) return "All day";
  const tz = eventTz(e, fallbackTz);
  const there = clock(e.startsAt, tz);
  const here = clock(e.startsAt, viewer);
  if (tz === viewer || there === here) return there;
  const ek = dayKey(e.startsAt, tz), vk = dayKey(e.startsAt, viewer);
  const shift = vk === ek ? "" : vk > ek ? ", next day" : ", previous day";
  return `${there} · ${here} your time${shift}`;
}

/** An event is over when it ended; with no end, three hours after the start (an all-day event: at the end of its day). */
export function isPast(e: Pick<Event, "startsAt" | "endsAt" | "allDay" | "tz">, now: number, fallbackTz: string): boolean {
  if (e.endsAt) return Date.parse(e.endsAt) < now;
  if (e.allDay) return dayKey(e.startsAt, eventTz(e, fallbackTz)) < dayKey(now, eventTz(e, fallbackTz));
  return Date.parse(e.startsAt) + 3 * 3600_000 < now;
}

export interface DayGroup {
  day: string;
  label: string;
  /** The first `maxPerDay` by score, in time order. */
  shown: FeedItem[];
  /** The rest, in time order. */
  more: FeedItem[];
  /** Every item of the day in time order (what the expander reveals). */
  all: FeedItem[];
}

/**
 * Group items by the day on the wall clock where the event happens
 * (an event at 23:30 in Madrid stays on its Madrid day, whatever the viewer's zone is).
 */
export function groupByDay(items: FeedItem[], opts: { now: number; maxPerDay: number; fallbackTz: string }): DayGroup[] {
  const byDay = new Map<string, { tz: string; items: FeedItem[] }>();
  for (const it of items) {
    const tz = eventTz(it.event, opts.fallbackTz);
    const k = it.event.allDay ? it.event.startsAt.slice(0, 10) : dayKey(it.event.startsAt, tz);
    const g = byDay.get(k) ?? { tz, items: [] };
    g.items.push(it);
    byDay.set(k, g);
  }
  const days = [...byDay.keys()].sort();
  return days.map((day) => {
    const g = byDay.get(day)!;
    const all = [...g.items].sort((a, b) => Date.parse(a.event.startsAt) - Date.parse(b.event.startsAt));
    const top = new Set([...g.items].sort((a, b) => b.score - a.score).slice(0, Math.max(1, opts.maxPerDay)));
    const shown = all.filter((i) => top.has(i));
    const more = all.filter((i) => !top.has(i));
    return { day, label: relativeDayLabel(day, all, g.tz, opts.now), shown, more, all };
  });
}

/** "Tonight" / "Today" / "Tomorrow" / "Sat 24 Oct", against today on the wall clock of `tz`. */
export function relativeDayLabel(day: string, items: FeedItem[], tz: string, now: number): string {
  const today = dayKey(now, tz);
  if (day === today) {
    const earliest = Math.min(...items.map((i) => (i.event.allDay ? 0 : hourIn(i.event.startsAt, eventTz(i.event, tz)))));
    return earliest >= 17 ? "Tonight" : "Today";
  }
  if (day === addDays(today, 1)) return "Tomorrow";
  return dayLabel(day);
}

/** The window a day falls in: a trip or manual window beats home. */
export function windowFor(day: string, windows: Window[]): Window | null {
  const hit = windows.filter((w) => w.from <= day && day <= w.to);
  return hit.find((w) => w.source !== "home") ?? hit[0] ?? null;
}

export function windowKey(w: Window): string {
  return w.id ?? `${w.source}:${w.city}:${w.from}:${w.to}`;
}

/** "In Tokyo · Dec 8–21", or null at home. */
export function cityLine(w: Window | null): string | null {
  if (!w || w.source === "home") return null;
  return `In ${w.city} · ${rangeLabel(w.from, w.to)}`;
}

export const STATES_VISIBLE: FeedState[] = ["new", "saved", "going", "went", "skipped"];
