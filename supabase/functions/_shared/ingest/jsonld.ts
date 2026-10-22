// schema.org Event markup in a web page: every <script type="application/ld+json">,
// walked through @graph, arrays and ItemList, keeping Event and its subtypes.

import { fetchText } from "./http.ts";
import { robotsAllows } from "./robots.ts";
import {
  categorize,
  cleanText,
  fold,
  isCategory,
  looksLikeAddress,
  resolveUrl,
  sameCity,
  sourceCategory,
} from "./normalize.ts";
import { DAY, defaultTz, isoInstant, isValidTz, wallToInstant } from "./time.ts";
import type { Adapter, IngestEvent, SourceRow } from "./types.ts";

type Json = Record<string, unknown>;

const EVENT_TYPES = new Set([
  "Event",
  "BusinessEvent",
  "ChildrensEvent",
  "ComedyEvent",
  "CourseInstance",
  "DanceEvent",
  "EducationEvent",
  "ExhibitionEvent",
  "Festival",
  "FoodEvent",
  "Hackathon",
  "LiteraryEvent",
  "MusicEvent",
  "ScreeningEvent",
  "SocialEvent",
  "SportsEvent",
  "TheaterEvent",
  "VisualArtsEvent",
]);

const TYPE_CATEGORY: Record<string, string> = {
  MusicEvent: "music",
  TheaterEvent: "theatre",
  DanceEvent: "theatre",
  ComedyEvent: "theatre",
  ExhibitionEvent: "art",
  VisualArtsEvent: "art",
  Festival: "festival",
  SportsEvent: "sport",
  EducationEvent: "talk",
  CourseInstance: "talk",
  LiteraryEvent: "talk",
  BusinessEvent: "meetup",
  SocialEvent: "meetup",
  ScreeningEvent: "film",
  FoodEvent: "food",
  ChildrensEvent: "family",
  Hackathon: "tech",
};

function typeName(t: unknown): string {
  return String(t ?? "").replace(/^.*[/#:]/, "");
}

function types(node: Json): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).map(typeName).filter(Boolean);
}

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The parsed JSON of every ld+json script in `html`. A block that does not parse is skipped. */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(m[1])) continue;
    const body = m[2].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/^<!--|-->$/g, "").trim();
    if (!body) continue;
    // deno-lint-ignore no-control-regex
    for (const attempt of [body, body.replace(/[\u0000-\u001f]+/g, " ")]) {
      try {
        out.push(JSON.parse(attempt));
        break;
      } catch { /* try the next form */ }
    }
  }
  return out;
}

export function collectEvents(node: unknown, out: Json[] = [], depth = 0): Json[] {
  if (depth > 8) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectEvents(n, out, depth + 1);
  } else if (isObj(node)) {
    if (types(node).some((t) => EVENT_TYPES.has(t))) {
      out.push(node);
      return out; // do not read an event's sub-objects as events
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") collectEvents(v, out, depth + 1);
  }
  return out;
}

// ---- field readers -------------------------------------------------------

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (isObj(v) && typeof v.name === "string") return v.name;
  return "";
}

function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** "2026-10-24", "2026-10-24T20:00", "...Z", "...+02:00". Without an offset, `tz` clocks apply. */
export function parseLdDate(s: unknown, tz: string | null): { ms: number; dateOnly: boolean } | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
    s.trim(),
  );
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (isNaN(wall)) return null;
  if (m[4] === undefined) return { ms: wallToInstant(wall, tz), dateOnly: true };
  if (!m[7]) return { ms: wallToInstant(wall, tz), dateOnly: false };
  if (m[7] === "Z") return { ms: wall, dateOnly: false };
  const sign = m[7][0] === "-" ? -1 : 1;
  const digits = m[7].slice(1).replace(":", "");
  return { ms: wall - sign * (+digits.slice(0, 2) * 60 + +digits.slice(2)) * 60_000, dateOnly: false };
}

function price(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.replace(/[^\d.,-]/g, "");
  if (!t) return null;
  // "1.234,50" and "12,50" are decimal-comma; "1,234.50" is not.
  const n = /,\d{1,2}$/.test(t) ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readOffers(
  ev: Json,
): { min: number | null; max: number | null; currency: string | null; free: boolean | null; url: string | null } {
  const offers = ([] as unknown[]).concat(ev.offers ?? []).filter(isObj);
  const nums: number[] = [];
  let currency: string | null = null;
  let url: string | null = null;
  for (const o of offers) {
    for (const k of ["price", "lowPrice", "highPrice"]) {
      const n = price(o[k]);
      if (n !== null) nums.push(n);
    }
    if (typeof o.priceCurrency === "string" && !currency) currency = o.priceCurrency.toUpperCase().slice(0, 3);
    if (typeof o.url === "string" && !url) url = o.url;
  }
  const min = nums.length ? Math.min(...nums) : null;
  const max = nums.length ? Math.max(...nums) : null;
  const accessible = ev.isAccessibleForFree === true || ev.isAccessibleForFree === "true" ||
    offers.some((o) => o.isAccessibleForFree === true);
  const free = accessible || (max === 0 && nums.length > 0) ? true : min !== null && min > 0 ? false : null;
  return { min, max, currency, free, url };
}

function readImage(v: unknown, base: string): string | null {
  const f = first(v as unknown);
  if (typeof f === "string") return resolveUrl(f, base);
  if (isObj(f)) return resolveUrl(f.url ?? f.contentUrl, base);
  return null;
}

interface Place {
  name: string;
  street: string;
  locality: string;
  country: string | null;
  lat: number | null;
  lon: number | null;
}

function readPlace(loc: unknown): Place | "virtual" | null {
  const places = ([] as unknown[]).concat(loc ?? []);
  let sawVirtual = false;
  for (const p of places) {
    if (typeof p === "string") {
      if (p.trim()) {
        return {
          name: looksLikeAddress(p) ? "" : p.trim(),
          street: looksLikeAddress(p) ? p.trim() : "",
          locality: "",
          country: null,
          lat: null,
          lon: null,
        };
      }
      continue;
    }
    if (!isObj(p)) continue;
    if (types(p).includes("VirtualLocation")) {
      sawVirtual = true;
      continue;
    }
    const a = isObj(p.address) ? p.address : null;
    const addrString = typeof p.address === "string" ? p.address : "";
    const street = a ? str(a.streetAddress) : addrString;
    const postal = a ? str(a.postalCode) : "";
    const country = a ? str(a.addressCountry) : "";
    const geo = isObj(p.geo) ? p.geo : null;
    const lat = geo ? Number(geo.latitude) : NaN;
    const lon = geo ? Number(geo.longitude) : NaN;
    return {
      name: str(p.name),
      street: [street, postal].filter(Boolean).join(", "),
      locality: a ? str(a.addressLocality) : "",
      country: /^[a-z]{2}$/i.test(country.trim()) ? country.trim().toUpperCase() : null,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    };
  }
  return sawVirtual ? "virtual" : null;
}

function readCategory(ev: Json, title: string, source: SourceRow): string {
  const ts = types(ev);
  const typed = ts.map((t) => TYPE_CATEGORY[t]).find(Boolean);
  const guessed = categorize(`${title} ${typeof ev.keywords === "string" ? ev.keywords : ""}`);
  if (typed === "music" && guessed === "nightlife") return "nightlife";
  if (typed && isCategory(typed)) return typed;
  return guessed ?? sourceCategory(source) ?? "other";
}

/** One schema.org Event node as an IngestEvent, or null when it has no usable name or date. */
export function eventFromNode(ev: Json, pageUrl: string, source: SourceRow): IngestEvent | null {
  let title = cleanText(str(ev.name), 200).replace(/\s*\n\s*/g, " ");
  if (!title) return null;

  const mode = str(ev.eventAttendanceMode);
  if (/OnlineEventAttendanceMode$/.test(mode)) return null;
  const place = readPlace(ev.location);
  if (place === "virtual") return null;

  const city = !place?.locality
    ? source.city
    : sameCity(place.locality, source.city)
    ? source.city
    : cleanText(place.locality, 120);
  const country = place?.country ?? source.country;
  const tz = defaultTz(city, country) ?? defaultTz(source.city, source.country);
  const start = parseLdDate(ev.startDate, isValidTz(tz) ? tz : null);
  if (!start) return null;
  const allDay = start.dateOnly;
  let endMs: number | null = null;
  const end = parseLdDate(ev.endDate, isValidTz(tz) ? tz : null);
  if (end) {
    // A date-only end is the last day, inclusive: the event is over at the next midnight.
    endMs = end.dateOnly ? end.ms + DAY : end.ms;
    if (endMs <= start.ms) endMs = null;
  }

  const offers = readOffers(ev);
  let venue: string | null = place?.name ? cleanText(place.name, 160) : null;
  let address: string | null = place?.street || null;
  if (venue && looksLikeAddress(venue)) {
    address = address ?? venue;
    venue = null;
  }
  if (venue && sameCity(venue, place?.locality)) venue = null;
  // Ticket sites write "Artist @ Venue"; the venue is its own field.
  const tail = venue ? /^(.*\S)\s+(?:@|at)\s+(.+)$/i.exec(title) : null;
  if (tail && venue && fold(tail[2]) === fold(venue)) title = tail[1];
  if (address && place?.locality && !address.toLowerCase().includes(place.locality.toLowerCase())) {
    address += `, ${place.locality}`;
  }

  const url = resolveUrl(ev.url, pageUrl) ?? pageUrl;
  const ticketUrl = resolveUrl(offers.url, pageUrl);
  const keywords = typeof ev.keywords === "string"
    ? ev.keywords.split(",").map((k) => k.trim()).filter(Boolean)
    : Array.isArray(ev.keywords)
    ? ev.keywords.map(String)
    : [];

  return {
    title,
    startsAt: isoInstant(start.ms),
    endsAt: endMs === null ? null : isoInstant(endMs),
    allDay,
    tz: isValidTz(tz) ? tz : null,
    city,
    country,
    venue,
    address,
    lat: place?.lat ?? null,
    lon: place?.lon ?? null,
    category: readCategory(ev, title, source),
    tags: keywords.slice(0, 8),
    priceMin: offers.min,
    priceMax: offers.max,
    currency: offers.currency,
    isFree: offers.free,
    url,
    ticketUrl: ticketUrl && ticketUrl !== url ? ticketUrl : null,
    imageUrl: readImage(ev.image, pageUrl),
    lang: typeof ev.inLanguage === "string" ? ev.inLanguage : null,
    description: cleanText(str(ev.description), 600) || null,
    cancelled: /EventCancelled$/.test(str(ev.eventStatus)),
  };
}

export function parseJsonLdPage(
  html: string,
  pageUrl: string,
  source: SourceRow,
): { events: IngestEvent[]; skipped: number } {
  const nodes = collectEvents(extractJsonLd(html));
  const events: IngestEvent[] = [];
  let skipped = 0;
  for (const n of nodes) {
    const e = eventFromNode(n, pageUrl, source);
    if (e) events.push(e);
    else skipped++;
  }
  dropSharedCoordinates(events);
  return { events, skipped };
}

/** Some listings give every event the city centre's coordinates. Where one point serves three venues, it is not a place. */
function dropSharedCoordinates(events: IngestEvent[]) {
  const venuesAt = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.lat == null || e.lon == null) continue;
    const k = `${e.lat},${e.lon}`;
    (venuesAt.get(k) ?? venuesAt.set(k, new Set()).get(k)!).add(fold(e.venue));
  }
  for (const e of events) {
    if (e.lat != null && e.lon != null && (venuesAt.get(`${e.lat},${e.lon}`)?.size ?? 0) >= 3) {
      e.lat = null;
      e.lon = null;
    }
  }
}

export const jsonldAdapter: Adapter = async (source, ctx) => {
  try {
    const robots = await robotsAllows(ctx.fetch, source.url, ctx.cache ??= new Map());
    if (!robots.ok) return { events: [], error: robots.error };
    const res = await fetchText(ctx.fetch, source.url, { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
    if (!res.ok) return { events: [], error: res.error };
    const { events } = parseJsonLdPage(res.text, res.url, source);
    if (!events.length && !/application\/ld\+json/i.test(res.text)) {
      return { events: [], error: "no JSON-LD on the page" };
    }
    return { events };
  } catch (e) {
    return { events: [], error: `jsonld: ${(e as Error).message}` };
  }
};
