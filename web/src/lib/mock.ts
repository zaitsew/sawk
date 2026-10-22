// Dev-only sample data (VITE_SAWK_MOCK=1 under `vite dev`). Everything here is invented:
// fictional venues, example.com links. It is never part of a production build.
import type { Event, FeedItem, Profile, Run, TokenRow, Window } from "../types";
import { addDays, clock, dayKey } from "./days";
import { applyFeedback } from "./store";

const MADRID = "Europe/Madrid";
const TOKYO = "Asia/Tokyo";

/** The instant at which the wall clock in `tz` reads `hour:minute` on `day`. */
function at(day: string, hour: number, minute: number, tz: string): string {
  const [y, m, d] = day.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d, hour, minute);
  for (let i = 0; i < 3; i++) {
    const got = clock(t, tz).split(":").map(Number);
    const gotDay = dayKey(t, tz);
    let diff = (hour - got[0]) * 60 + (minute - got[1]);
    if (gotDay > day) diff -= 1440; else if (gotDay < day) diff += 1440;
    if (diff === 0) break;
    t += diff * 60_000;
  }
  return new Date(t).toISOString();
}

function art(a: string, b: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><text x="100" y="108" font-family="Georgia,serif" font-size="22" text-anchor="middle" fill="#fff" fill-opacity=".85">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

let nid = 0;
function ev(p: Partial<Event> & Pick<Event, "title" | "startsAt" | "city" | "category">): Event {
  nid += 1;
  return {
    id: `sample-${nid}`, endsAt: null, allDay: false, tz: MADRID, country: "ES", venue: null, address: null,
    tags: [], priceMin: null, priceMax: null, currency: "EUR", isFree: null,
    url: "https://example.com/sample", ticketUrl: null, imageUrl: null, lang: "en",
    description: null, cancelled: false, ...p,
  };
}
function item(event: Event, score: number, reason: string, state: FeedItem["state"] = "new"): FeedItem {
  return { event, score, reason, rankedBy: "agent:sample", rankedAt: new Date().toISOString(), state, rating: null };
}

const today = dayKey(Date.now(), MADRID);
const D = (n: number) => addDays(today, n);

let items: FeedItem[] = [
  item(ev({ title: "Quartet night at La Sala Pequeña", startsAt: at(D(-1), 21, 0, MADRID), venue: "La Sala Pequeña", city: "Valencia", category: "music", priceMin: 10, priceMax: 10 }),
    0.9, "You saved two jazz nights last month, and this room seats forty.", "going"),
  item(ev({ title: "Open studio day in Russafa", startsAt: at(D(-2), 11, 0, MADRID), venue: "Taller Norte", city: "Valencia", category: "art", isFree: true }),
    0.7, "Small, quiet, no tickets: the kind you said you like.", "saved"),
  item(ev({ title: "Late set: trio and a cellist", startsAt: at(D(0), 22, 0, MADRID), endsAt: at(D(0), 23, 59, MADRID), venue: "Café Meridiano", city: "Valencia", category: "music", priceMin: 12, priceMax: 15, imageUrl: art("#b2441f", "#5b2a1c", "Sample") }),
    0.95, "Live jazz, under 20 euros, ten minutes from home. You rated the last one 4 of 5."),
  item(ev({ title: "Sunday-style market on a Thursday", startsAt: at(D(0), 18, 30, MADRID), venue: "Plaça del Mercat", city: "Valencia", category: "market", isFree: true }),
    0.5, "Free, and you can leave when the crowd gets loud."),
  item(ev({ title: "Morning ride along the old riverbed", startsAt: at(D(1), 9, 30, MADRID), venue: "Jardí del Túria", city: "Valencia", category: "outdoor", isFree: true, imageUrl: art("#3d6b5a", "#1f3b32", "Sample") }),
    0.8, "Easy pace, no sign-up, and you asked for more outdoors."),
  item(ev({ title: "Silent film with a live piano", startsAt: at(D(1), 20, 30, MADRID), venue: "Cine Albatros", city: "Valencia", category: "film", priceMin: 6, priceMax: 6 }),
    0.9, "No talking in the room, by design.", "saved"),
  item(ev({ title: "Talk: how cities get quieter", startsAt: at(D(1), 19, 0, MADRID), venue: "Ateneo Mercantil", city: "Valencia", category: "talk", isFree: true }),
    0.6, "You read about noise maps in March; this one is local."),
  item(ev({ title: "Techno until sunrise", startsAt: at(D(1), 23, 59, MADRID), venue: "Nave 9", city: "Valencia", category: "nightlife", priceMin: 15, priceMax: 25 }),
    0.2, "Loud and late. Here only because nothing else matched that night."),
  item(ev({ title: "Board games, no pressure", startsAt: at(D(1), 18, 0, MADRID), venue: "Ludoteca Gris", city: "Valencia", category: "meetup", priceMin: 0, priceMax: 0 }),
    0.45, "Tables of four, and nobody has to introduce themselves."),
  item(ev({ title: "Beach cleanup and paella", startsAt: at(D(3), 10, 0, MADRID), venue: "Platja de la Malva-rosa", city: "Valencia", category: "outdoor", isFree: true }),
    0.55, "Outdoors, a task to do with your hands, a lunch at the end.", "going"),
  item(ev({ title: "Ceramics for beginners", startsAt: at(D(5), 17, 0, MADRID), venue: "Barro y Torno", city: "Valencia", category: "art", priceMin: 28, priceMax: 28 }),
    0.65, "Six people at most. You asked to try something with your hands."),
  item(ev({ title: "Kissaten jazz hour", startsAt: at(D(10), 20, 0, TOKYO), tz: TOKYO, city: "Tokyo", country: "JP", venue: "Café Kagetsu", category: "music", priceMin: 1500, priceMax: 2000, currency: "JPY", imageUrl: art("#2c3e66", "#141c33", "Sample") }),
    0.9, "A tiny jazz kissa near your hotel. You will be in Tokyo that week."),
  item(ev({ title: "Morning fish market walk", startsAt: at(D(11), 6, 30, TOKYO), tz: TOKYO, city: "Tokyo", country: "JP", venue: "Toyosu", category: "food", isFree: true }),
    0.7, "Early and quiet, and breakfast is the point."),
  item(ev({ title: "Print fair in Kuramae", startsAt: at(D(12), 11, 0, TOKYO), tz: TOKYO, city: "Tokyo", country: "JP", venue: "Studio Hako", category: "market", priceMin: 0, priceMax: 0, currency: "JPY" }),
    0.6, "Zines and small presses, like the one you bought last year."),
];

const windows: Window[] = [
  { city: "Valencia", country: "ES", tz: MADRID, from: D(-7), to: D(60), source: "home" },
  { city: "Tokyo", country: "JP", tz: TOKYO, from: D(9), to: D(15), source: "loco", id: "sample-trip" },
];

let profile: Profile = {
  homeCity: "Valencia", homeCountry: "ES", homeTz: MADRID, langs: ["en", "es"],
  likes: ["jazz", "small rooms", "film", "markets"], avoids: ["clubs", "stand-up"],
  notes: "I do better with a clear start and end time, and with seats.", priceMax: 30, currency: "EUR", maxPerDay: 3,
};

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const runs: Run[] = [
  { id: "r1", agent: "claude-code", model: "claude-sonnet-5-5", startedAt: ago(9), finishedAt: ago(8.9), status: "ok", cities: ["Valencia"], eventsAdded: 18, ranked: 31, notes: null },
  { id: "r2", agent: "ingest", model: null, startedAt: ago(9.5), finishedAt: ago(9.4), status: "ok", cities: ["Valencia", "Tokyo"], eventsAdded: 42, ranked: 0, notes: null },
  { id: "r3", agent: "codex", model: "gpt-6.1-sol", startedAt: ago(33), finishedAt: ago(32.8), status: "partial", cities: ["Tokyo"], eventsAdded: 6, ranked: 9, notes: "Two sources timed out." },
  { id: "r4", agent: "chatgpt", model: null, startedAt: ago(57), finishedAt: ago(57), status: "failed", cities: [], eventsAdded: 0, ranked: 0, notes: "Connector was not signed in." },
];

let tokens: TokenRow[] = [
  { id: "t1", name: "Laptop (Claude Code)", prefix: "sawk_pat_8Fq2", createdAt: ago(24 * 12), lastUsedAt: ago(9), revokedAt: null },
  { id: "t2", name: "Codex nightly", prefix: "sawk_pat_Zk91", createdAt: ago(24 * 5), lastUsedAt: ago(33), revokedAt: null },
];

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

export async function handle(method: string, path: string, body: unknown): Promise<unknown> {
  await wait();
  const [route] = path.split("?");
  const b = (body ?? {}) as Record<string, unknown>;
  if (method === "GET" && route === "/api/feed") return items;
  if (method === "GET" && route === "/api/context") return { windows };
  if (method === "POST" && route === "/api/feedback") {
    items = applyFeedback(items, String(b.eventId), b.action as never, b.rating as number | undefined);
    return items.find((i) => i.event.id === b.eventId) ?? null;
  }
  if (route === "/api/profile") {
    if (method === "PUT") profile = { ...profile, ...(b as Partial<Profile>) };
    return profile;
  }
  if (method === "GET" && route === "/api/runs") return runs;
  if (route === "/api/tokens" && method === "GET") return tokens.filter((t) => !t.revokedAt);
  if (route === "/api/tokens" && method === "POST") {
    const row: TokenRow = {
      id: `t${Date.now()}`, name: String(b.name || "Agent"), prefix: "sawk_pat_Sample",
      createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null,
    };
    tokens = [row, ...tokens];
    return { ...row, token: "sawk_pat_SAMPLE0000000000000000000000000" };
  }
  if (route.startsWith("/api/tokens/") && method === "DELETE") {
    const id = decodeURIComponent(route.slice("/api/tokens/".length));
    tokens = tokens.filter((t) => t.id !== id);
    return null;
  }
  throw new Error(`mock: no route ${method} ${path}`);
}
