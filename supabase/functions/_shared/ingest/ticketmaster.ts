// Ticketmaster Discovery API v2. The source's url holds the query, e.g.
//   ticketmaster:city=Valencia&countryCode=ES
// The key comes from TICKETMASTER_API_KEY and never appears in a stored value
// or an error message. Limit: 5 requests per second.

import { fetchText } from "./http.ts";
import { categorize, cleanText, isHttpUrl, sameCity, sourceCategory } from "./normalize.ts";
import { DAY, defaultTz, isoInstant, isValidTz, wallToInstant } from "./time.ts";
import type { Adapter, IngestEvent, SourceRow } from "./types.ts";

const ENDPOINT = "https://app.ticketmaster.com/discovery/v2/events.json";
export const TM_PAGE_SIZE = 200;
export const TM_MAX_PAGES = 3; // the API refuses deep paging beyond 1000 results
export const TM_WINDOW_DAYS = 60;
const MIN_GAP_MS = 220; // < 5 requests per second
// Parameters the adapter sets itself.
const RESERVED = new Set(["apikey", "size", "page", "sort", "startdatetime", "enddatetime"]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export function parseTmQuery(url: string): URLSearchParams {
  const q = new URLSearchParams(url.replace(/^ticketmaster:/i, "").replace(/^\?/, ""));
  for (const k of [...q.keys()]) if (RESERVED.has(k.toLowerCase())) q.delete(k);
  return q;
}

function tmStamp(ms: number): string {
  return isoInstant(ms).replace(/\.\d+Z$/, "Z");
}

function category(ev: Json, title: string, source: SourceRow): string {
  const cl = ([] as unknown[]).concat(ev.classifications ?? []).filter(isObj);
  const c = cl.find((x) => x.primary === true) ?? cl[0];
  const name = (k: string) => {
    const o = c?.[k];
    return isObj(o) && typeof o.name === "string" && o.name !== "Undefined" ? o.name.toLowerCase() : "";
  };
  const segment = name("segment");
  const genre = name("genre");
  if (segment === "music") return genre.includes("dance") || genre.includes("electronic") ? "nightlife" : "music";
  if (segment === "sports") return "sport";
  if (segment === "film") return "film";
  if (segment.startsWith("arts")) {
    if (genre.includes("fine art") || genre.includes("performance art") || genre.includes("cultural")) return "art";
    if (genre.includes("children")) return "family";
    return "theatre";
  }
  if (genre.includes("family")) return "family";
  if (genre.includes("festival") || genre.includes("fair")) return "festival";
  if (genre.includes("food")) return "food";
  return categorize(title) ?? sourceCategory(source) ?? "other";
}

export function eventFromTm(ev: Json, source: SourceRow): IngestEvent | null {
  const title = cleanText(ev.name, 200);
  const url = typeof ev.url === "string" && isHttpUrl(ev.url) ? ev.url : null;
  if (!title || !url) return null;
  const dates = isObj(ev.dates) ? ev.dates : {};
  const start = isObj(dates.start) ? dates.start : {};
  const status = isObj(dates.status) && typeof dates.status.code === "string" ? dates.status.code.toLowerCase() : "";
  if (status === "postponed" || status === "rescheduled") return null; // the date is not reliable

  const venue = isObj(ev._embedded)
    ? ([] as unknown[]).concat((ev._embedded as Json).venues ?? []).filter(isObj)[0]
    : undefined;
  const vCity = venue && isObj(venue.city) && typeof venue.city.name === "string" ? venue.city.name : "";
  const vCountry = venue && isObj(venue.country) && typeof venue.country.countryCode === "string"
    ? venue.country.countryCode.toUpperCase()
    : null;
  const city = !vCity ? source.city : sameCity(vCity, source.city) ? source.city : cleanText(vCity, 120);
  const country = vCountry ?? source.country;
  const tzCandidate = typeof dates.timezone === "string"
    ? dates.timezone
    : typeof venue?.timezone === "string"
    ? venue.timezone
    : null;
  const tz = isValidTz(tzCandidate) ? tzCandidate : defaultTz(city, country);

  let startMs: number;
  let allDay = false;
  if (typeof start.dateTime === "string" && !isNaN(Date.parse(start.dateTime))) {
    startMs = Date.parse(start.dateTime);
  } else if (typeof start.localDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start.localDate)) {
    const time = typeof start.localTime === "string" && /^\d{2}:\d{2}/.test(start.localTime) ? start.localTime : null;
    const wall = Date.parse(`${start.localDate}T${time ? time.slice(0, 8).padEnd(8, ":00").slice(0, 8) : "00:00:00"}Z`);
    if (isNaN(wall)) return null;
    startMs = wallToInstant(wall, tz);
    allDay = !time || start.timeTBA === true;
  } else return null;
  if (start.timeTBA === true && typeof start.dateTime !== "string") allDay = true;

  const ranges = ([] as unknown[]).concat(ev.priceRanges ?? []).filter(isObj);
  const mins = ranges.map((r) => Number(r.min)).filter(Number.isFinite);
  const maxs = ranges.map((r) => Number(r.max)).filter(Number.isFinite);
  const currency = ranges.find((r) => typeof r.currency === "string")?.currency;

  const images = ([] as unknown[]).concat(ev.images ?? []).filter(isObj)
    .filter((i) => typeof i.url === "string" && isHttpUrl(i.url))
    .map((i) => ({ url: i.url as string, w: Number(i.width) || 0 }));
  const wide = images.filter((i) => i.w >= 640).sort((a, b) => b.w - a.w)[0] ?? images.sort((a, b) => b.w - a.w)[0];

  const loc = venue && isObj(venue.location) ? venue.location : null;
  const lat = loc ? Number(loc.latitude) : NaN;
  const lon = loc ? Number(loc.longitude) : NaN;
  const address = venue && isObj(venue.address) && typeof venue.address.line1 === "string" ? venue.address.line1 : "";
  const postal = venue && typeof venue.postalCode === "string" ? venue.postalCode : "";

  const cl = ([] as unknown[]).concat(ev.classifications ?? []).filter(isObj);
  const tags = new Set<string>();
  for (const k of ["segment", "genre", "subGenre"]) {
    const o = cl[0]?.[k];
    if (isObj(o) && typeof o.name === "string" && o.name !== "Undefined") tags.add(o.name.toLowerCase());
  }

  return {
    title,
    startsAt: isoInstant(startMs),
    endsAt: isObj(dates.end) && typeof dates.end.dateTime === "string" && Date.parse(dates.end.dateTime) > startMs
      ? isoInstant(Date.parse(dates.end.dateTime))
      : allDay
      ? isoInstant(startMs + DAY)
      : null,
    allDay,
    tz: isValidTz(tz) ? tz : null,
    city,
    country,
    venue: venue && typeof venue.name === "string" ? cleanText(venue.name, 160) : null,
    address: address ? [address, postal].filter(Boolean).join(", ") : null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    category: category(ev, title, source),
    tags: [...tags],
    priceMin: mins.length ? Math.min(...mins) : null,
    priceMax: maxs.length ? Math.max(...maxs) : null,
    currency: typeof currency === "string" ? currency : null,
    isFree: null,
    url,
    ticketUrl: url,
    imageUrl: wide?.url ?? null,
    lang: typeof ev.locale === "string" ? ev.locale.slice(0, 2).toLowerCase() : null,
    description: cleanText(ev.info ?? ev.pleaseNote, 600) || null,
    cancelled: status === "cancelled" || status === "canceled",
  };
}

export const ticketmasterAdapter: Adapter = async (source, ctx) => {
  const key = ctx.env("TICKETMASTER_API_KEY");
  if (!key) return { events: [], error: "no key" };
  const redact = (s: string) => s.split(key).join("***");
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const events: IngestEvent[] = [];
  try {
    const query = parseTmQuery(source.url);
    let last = 0;
    for (let page = 0; page < TM_MAX_PAGES; page++) {
      const q = new URLSearchParams(query);
      q.set("apikey", key);
      q.set("size", String(TM_PAGE_SIZE));
      q.set("page", String(page));
      q.set("sort", "date,asc");
      q.set("startDateTime", tmStamp(ctx.now.getTime()));
      q.set("endDateTime", tmStamp(ctx.now.getTime() + TM_WINDOW_DAYS * DAY));
      const wait = last + MIN_GAP_MS - Date.now();
      if (page > 0 && wait > 0) await sleep(wait);
      last = Date.now();
      const res = await fetchText(ctx.fetch, `${ENDPOINT}?${q}`, { accept: "application/json" });
      if (!res.ok) return { events, error: redact(`ticketmaster: ${res.error}`) };
      let body: Json;
      try {
        body = JSON.parse(res.text);
      } catch {
        return { events, error: "ticketmaster: response is not JSON" };
      }
      const list = isObj(body._embedded)
        ? ([] as unknown[]).concat((body._embedded as Json).events ?? []).filter(isObj)
        : [];
      for (const ev of list) {
        const e = eventFromTm(ev, source);
        if (e) events.push(e);
      }
      const totalPages = isObj(body.page) ? Number(body.page.totalPages) : 1;
      if (!list.length || page + 1 >= totalPages) break;
    }
    return { events };
  } catch (e) {
    return { events, error: redact(`ticketmaster: ${(e as Error).message}`) };
  }
};
