// Time zones without a library: wall-clock <-> instant conversion through Intl.
//
// A "wall" value is a wall-clock reading stored as the epoch milliseconds of
// the same fields read as UTC (so 2026-10-24 22:00 in Madrid is
// Date.UTC(2026, 9, 24, 22)). That makes calendar arithmetic (add a day,
// step a week) independent of DST; `wallToInstant` turns it into a real instant.

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  if (formatters.has(tz)) return formatters.get(tz) ?? null;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    f = null;
  }
  formatters.set(tz, f);
  return f;
}

export function isValidTz(tz: string | null | undefined): tz is string {
  return !!tz && formatter(tz) !== null;
}

/** The wall-clock reading of an instant in `tz`. */
export function instantToWall(ms: number, tz: string): number {
  const f = formatter(tz);
  if (!f) return ms;
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}

/** Offset of `tz` from UTC at an instant, in ms. */
export function tzOffsetMs(ms: number, tz: string): number {
  return instantToWall(Math.floor(ms / 1000) * 1000, tz) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which `tz`'s clocks read `wall`. In a DST gap, the instant just after it. */
export function wallToInstant(wall: number, tz: string | null | undefined): number {
  if (!isValidTz(tz)) return wall;
  const first = wall - tzOffsetMs(wall, tz);
  return wall - tzOffsetMs(first, tz);
}

export const DAY = 86_400_000;

export function wallParts(wall: number) {
  const d = new Date(wall);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    dow: d.getUTCDay(), // 0 = Sunday
  };
}

export function isoInstant(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** YYYY-MM-DD of a wall value. */
export function wallDate(wall: number): string {
  return new Date(wall).toISOString().slice(0, 10);
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function todayIn(now: Date, tz: string | null | undefined): string {
  return wallDate(isValidTz(tz) ? instantToWall(now.getTime(), tz) : now.getTime());
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
}

/** Default time zones for the cities and countries the seed and tests use. Anything else: the country's main zone. */
const CITY_TZ: Record<string, string> = {
  valencia: "Europe/Madrid",
  madrid: "Europe/Madrid",
  barcelona: "Europe/Madrid",
  sevilla: "Europe/Madrid",
  lisbon: "Europe/Lisbon",
  lisboa: "Europe/Lisbon",
  london: "Europe/London",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  rome: "Europe/Rome",
  amsterdam: "Europe/Amsterdam",
  "new york": "America/New_York",
  "los angeles": "America/Los_Angeles",
  chicago: "America/Chicago",
  tokyo: "Asia/Tokyo",
  dubai: "Asia/Dubai",
  istanbul: "Europe/Istanbul",
};
const COUNTRY_TZ: Record<string, string> = {
  ES: "Europe/Madrid",
  PT: "Europe/Lisbon",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  FR: "Europe/Paris",
  DE: "Europe/Berlin",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  BE: "Europe/Brussels",
  AT: "Europe/Vienna",
  CH: "Europe/Zurich",
  PL: "Europe/Warsaw",
  CZ: "Europe/Prague",
  GR: "Europe/Athens",
  TR: "Europe/Istanbul",
  JP: "Asia/Tokyo",
  AE: "Asia/Dubai",
  TH: "Asia/Bangkok",
  MX: "America/Mexico_City",
  AR: "America/Argentina/Buenos_Aires",
  BR: "America/Sao_Paulo",
  CO: "America/Bogota",
};

export function defaultTz(city: string | null | undefined, country: string | null | undefined): string | null {
  const c = (city ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return CITY_TZ[c] ?? COUNTRY_TZ[(country ?? "").toUpperCase()] ?? null;
}
