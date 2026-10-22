// What every adapter's output goes through before it reaches the database:
// text cleaning, the category guess, city/country/tz defaults, and the rule
// "keep only what is still to come and not absurdly far ahead".

import { CATEGORIES, type Category } from "../types.ts";
import { eventId } from "../ids.ts";
import { DAY, defaultTz, isoInstant, isValidTz } from "./time.ts";
import type { IngestEvent, SourceRow } from "./types.ts";

export const MAX_DAYS_AHEAD = 400;
const DESCRIPTION_MAX = 600;
const TITLE_MAX = 200;

/** An event ready to write: defaults filled, id computed. */
export interface ReadyEvent extends Omit<IngestEvent, "tags" | "allDay"> {
  id: string;
  tags: string[];
  allDay: boolean;
  tz: string | null;
  country: string | null;
  category: Category;
  cancelled: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  euro: "€",
  iexcl: "¡",
  iquest: "¿",
  ordf: "ª",
  ordm: "º",
  laquo: "«",
  raquo: "»",
  copy: "©",
  szlig: "ß",
  middot: "·",
  bull: "•",
};
// aacute, egrave, ntilde, ccedil, uuml ...: a letter plus its mark, where a single character exists.
for (
  const [name, mark] of [
    ["acute", "\u0301"],
    ["grave", "\u0300"],
    ["circ", "\u0302"],
    ["uml", "\u0308"],
    ["tilde", "\u0303"],
    ["cedil", "\u0327"],
    ["ring", "\u030A"],
  ]
) {
  for (const c of "AEIOUYaeiouynNcC") {
    const composed = (c + mark).normalize("NFC");
    if ([...composed].length === 1) ENTITIES[c + name] = composed;
  }
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text: entities decoded, tags dropped, whitespace collapsed. */
export function cleanText(s: unknown, max = Infinity): string {
  if (typeof s !== "string") return "";
  let t = decodeEntities(s).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "");
  t = t.replace(/[ \t\f\v\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Lowercase, no accents, words separated by single spaces. (ids.norm also drops filler words; this keeps them.) */
export function fold(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// First match wins, so the order is the priority.
const CATEGORY_RULES: [Category, RegExp][] = [
  ["festival", /\b(festival|fest|fiestas?|fallas|feria)\b/],
  [
    "nightlife",
    /\b(dj|djs|clubbing|night ?club|nightlife|party|after ?party|discoteca|pub crawl|rave|techno|house music)\b/,
  ],
  ["film", /\b(film|films|cine|cinema|movie|pelicula|peliculas|screening|proyeccion|documental|documentary)\b/],
  [
    "theatre",
    /\b(teatro|theatre|theater|obra|musical|opera|ballet|danza|dance|comedia|comedy|stand up|standup|monologo|circo|circus|magia|magic show|flamenco)\b/,
  ],
  [
    "music",
    /\b(concierto|concert|jazz|blues|rock|pop|orquesta|orchestra|symphony|sinfonica|recital|coro|choir|gig|live music|musica|music|opera|cantautor|band)\b/,
  ],
  [
    "art",
    /\b(exposicion|exposiciones|exhibition|museo|museum|galeria|gallery|arte|art|fotografia|photography|escultura|visita guiada|guided tour)\b/,
  ],
  [
    "tech",
    /\b(hackathon|startup|startups|developer|developers|devops|coding|programming|python|javascript|blockchain|ai|artificial intelligence|machine learning|data science|tech|cloud|saas|founders?)\b/,
  ],
  [
    "talk",
    /\b(charla|talk|conferencia|conference|lecture|panel|workshop|taller|seminar|seminario|masterclass|book club|club de lectura|presentacion|debate|filosofia|philosophy)\b/,
  ],
  [
    "food",
    /\b(gastro|gastronomia|food|wine|vino|cata|tasting|brunch|cooking|cocina|paella|cerveza|beer|tapas|vermut|degustacion|restaurant)\b/,
  ],
  [
    "sport",
    /\b(football|futbol|soccer|basket|baloncesto|running|marathon|maraton|carrera|match|partido|padel|tennis|yoga|fitness|rugby|volleyball|triathlon|cycling race)\b/,
  ],
  ["market", /\b(mercado|market|rastro|flea|mercadillo|mercat|bazar|bazaar)\b/],
  ["family", /\b(ninos|kids|family|familiar|familias|infantil|children|childrens|ninas)\b/],
  [
    "outdoor",
    /\b(hike|hiking|senderismo|ruta|excursion|walk|walks|paseo|beach|playa|bike|cycling|kayak|trekking|nature|naturaleza|picnic)\b/,
  ],
  [
    "meetup",
    /\b(meetup|networking|language exchange|intercambio|social|coffee|cafe|newcomers|expats?|friends|comunidad|community)\b/,
  ],
];

/** A category from words in `text`, or null when nothing matches. */
export function categorize(text: string): Category | null {
  const t = fold(text);
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return null;
}

export function isCategory(s: unknown): s is Category {
  return typeof s === "string" && (CATEGORIES as readonly string[]).includes(s);
}

/** A source's own category hint: its first valid category. */
export function sourceCategory(source: SourceRow): Category | null {
  return source.categories.find(isCategory) ?? null;
}

const FREE_RE =
  /\b(entrada libre|entrada gratuita|gratis|gratuito|gratuita|free entry|free admission|free event|free to attend|admission free|free of charge)\b/;
export function mentionsFree(text: string): boolean {
  return FREE_RE.test(fold(text));
}

const STREET_WORD =
  /^(?:c\/|(?:calle|carrer|avda|av|avenida|avinguda|plaza|pla[cç]a|paseo|passeig|camino|cam[ií]|ronda|street|st|road|rd|avenue|via|rue|strasse|stra[sß]e)\b)/i;

/** "Carrer de Baja, 28" is an address, "Jimmy Glass" is a venue. */
export function looksLikeAddress(s: string): boolean {
  return STREET_WORD.test(s.trim()) || /,\s*\d+/.test(s) || /^\d+\s/.test(s.trim());
}

export function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveUrl(u: unknown, base: string): string | null {
  if (typeof u !== "string" || !u.trim()) return null;
  try {
    const r = new URL(u.trim(), base);
    return r.protocol === "http:" || r.protocol === "https:" ? r.toString() : null;
  } catch {
    return null;
  }
}

function num(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Whether `city` is the source's own city, ignoring accents and case ("València" = "Valencia"). */
export function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  return fold(a) === fold(b) && fold(a) !== "";
}

export interface Finalized {
  events: ReadyEvent[];
  dropped: number;
}

/**
 * Fill defaults from the source row, drop what is over or too far ahead, compute ids.
 * One bad event is dropped, never the batch.
 */
export async function finalizeEvents(raw: IngestEvent[], source: SourceRow, now: Date): Promise<Finalized> {
  const out = new Map<string, ReadyEvent>();
  let dropped = 0;
  const nowMs = now.getTime();
  const farMs = nowMs + MAX_DAYS_AHEAD * DAY;

  for (const e of raw) {
    try {
      const title = cleanText(e.title, TITLE_MAX).replace(/\s*\n\s*/g, " ");
      const url = isHttpUrl(e.url) ? e.url : null;
      const start = Date.parse(e.startsAt);
      if (!title || !url || isNaN(start)) {
        dropped++;
        continue;
      }
      const allDay = e.allDay === true;
      let end = e.endsAt ? Date.parse(e.endsAt) : NaN;
      if (isNaN(end) || end < start) end = NaN;
      // When is it over? Its end; else a day for all-day events, three hours for timed ones.
      const over = isNaN(end) ? start + (allDay ? DAY : 3 * 3_600_000) : end;
      if (over < nowMs || start > farMs) {
        dropped++;
        continue;
      }

      const country = (e.country ?? source.country ?? "").toString().toUpperCase().slice(0, 2) || null;
      const city = cleanText(e.city || source.city, 120) || source.city;
      const tz = isValidTz(e.tz) ? e.tz : defaultTz(city, country) ?? defaultTz(source.city, source.country);
      const tags = [...new Set((e.tags ?? []).map((t) => fold(t)).filter((t) => t && t.length <= 40))].slice(0, 12);
      const description = cleanText(e.description, DESCRIPTION_MAX) || null;
      const category: Category = isCategory(e.category)
        ? e.category
        : categorize(`${title} ${tags.join(" ")}`) ?? sourceCategory(source) ?? "other";

      const priceMin = num(e.priceMin);
      const priceMax = num(e.priceMax);
      const free = e.isFree === true || (priceMin === 0 && (priceMax === null || priceMax === 0))
        ? true
        : e.isFree === false || (priceMin !== null && priceMin > 0)
        ? false
        : description && mentionsFree(`${title} ${description}`)
        ? true
        : null;

      const venue = cleanText(e.venue, 160) || null;
      const ready: ReadyEvent = {
        id: await eventId({ title, startsAt: isoInstant(start), tz, venue, city }),
        title,
        startsAt: isoInstant(start),
        endsAt: isNaN(end) ? null : isoInstant(end),
        allDay,
        tz,
        city,
        country,
        venue,
        address: cleanText(e.address, 240) || null,
        lat: num(e.lat) !== null && Math.abs(e.lat!) <= 90 ? e.lat! : null,
        lon: num(e.lon) !== null && Math.abs(e.lon!) <= 180 ? e.lon! : null,
        category,
        tags,
        priceMin,
        priceMax,
        currency: e.currency ? String(e.currency).toUpperCase().slice(0, 3) : null,
        isFree: free,
        url,
        ticketUrl: isHttpUrl(e.ticketUrl) ? e.ticketUrl : null,
        imageUrl: isHttpUrl(e.imageUrl) ? e.imageUrl : null,
        lang: e.lang ? String(e.lang).toLowerCase().slice(0, 8) : null,
        description,
        cancelled: e.cancelled === true,
      };
      // The same event twice in one source (a recurring rule plus an override): keep the first.
      if (!out.has(ready.id)) out.set(ready.id, ready);
      else dropped++;
    } catch {
      dropped++;
    }
  }
  return { events: [...out.values()], dropped };
}
