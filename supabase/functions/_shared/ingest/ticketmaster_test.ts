import { assert, assertEquals } from "jsr:@std/assert@1";
import { eventFromTm, parseTmQuery, ticketmasterAdapter, TM_MAX_PAGES } from "./ticketmaster.ts";
import { fakeFetch, fixture, NOW, source } from "./testing.ts";

const src = source({ kind: "ticketmaster", url: "ticketmaster:city=Valencia&countryCode=ES&apikey=leak&size=5" });
const KEY = "test-key-123";

Deno.test("the query comes from the source url; reserved parameters are not taken from it", () => {
  const q = parseTmQuery(src.url);
  assertEquals(q.get("city"), "Valencia");
  assertEquals(q.get("countryCode"), "ES");
  assertEquals(q.has("apikey"), false);
  assertEquals(q.has("size"), false);
});

Deno.test("without a key the source is skipped, not failed", async () => {
  const f = fakeFetch({});
  const r = await ticketmasterAdapter(src, { fetch: f, now: NOW, env: () => undefined });
  assertEquals(r, { events: [], error: "no key" });
  assertEquals(f.calls.length, 0);
});

Deno.test("the request: key, window, size, sort", async () => {
  const f = fakeFetch({
    "https://app.ticketmaster.com/*": { body: await fixture("ticketmaster.json"), type: "application/json" },
  });
  await ticketmasterAdapter(src, { fetch: f, now: NOW, env: (k) => (k === "TICKETMASTER_API_KEY" ? KEY : undefined) });
  assertEquals(f.calls.length, 1);
  const u = new URL(f.calls[0]);
  assertEquals(u.origin + u.pathname, "https://app.ticketmaster.com/discovery/v2/events.json");
  assertEquals(u.searchParams.get("apikey"), KEY);
  assertEquals(u.searchParams.get("city"), "Valencia");
  assertEquals(u.searchParams.get("size"), "200");
  assertEquals(u.searchParams.get("sort"), "date,asc");
  assertEquals(u.searchParams.get("startDateTime"), "2026-10-23T10:00:00Z");
  assertEquals(u.searchParams.get("endDateTime"), "2026-12-22T10:00:00Z");
});

Deno.test("events: category, price, widest image, venue, zone, cancelled, TBA time; postponed is dropped", async () => {
  const f = fakeFetch({
    "https://app.ticketmaster.com/*": { body: await fixture("ticketmaster.json"), type: "application/json" },
  });
  const r = await ticketmasterAdapter(src, { fetch: f, now: NOW, env: () => KEY });
  assertEquals(r.error, undefined);
  assertEquals(r.events.map((e) => e.title), ["Fixture Band Live", "Fixture FC vs Test United", "Comedy Evening"]);
  const [band, match, comedy] = r.events;
  assertEquals(band.startsAt, "2026-11-12T20:00:00Z");
  assertEquals(band.category, "music");
  assertEquals([band.priceMin, band.priceMax, band.currency], [25, 60, "EUR"]);
  assertEquals(band.imageUrl, "https://img.example/big.jpg");
  assertEquals(band.venue, "Arena Prueba");
  assertEquals(band.city, "Valencia"); // "València" is the source's city
  assertEquals(band.address, "Calle Arena 12, 46013");
  assertEquals([band.lat, band.lon], [39.4495, -0.3661]);
  assertEquals(band.tz, "Europe/Madrid");
  assertEquals(band.tags, ["music", "rock", "indie rock"]);
  assertEquals(band.lang, "es");
  assertEquals(band.description, "All ages.");
  assertEquals(match.cancelled, true);
  assertEquals(match.category, "sport");
  assertEquals(comedy.allDay, true); // time to be announced
  assertEquals(comedy.startsAt, "2026-11-30T23:00:00Z");
  assertEquals(comedy.category, "theatre");
});

Deno.test("paging is bounded and respects the rate gap", async () => {
  const page = {
    _embedded: { events: [JSON.parse(await fixture("ticketmaster.json"))._embedded.events[0]] },
    page: { totalPages: 9 },
  };
  const f = fakeFetch({ "https://app.ticketmaster.com/*": { body: JSON.stringify(page), type: "application/json" } });
  const waits: number[] = [];
  const r = await ticketmasterAdapter(src, {
    fetch: f,
    now: NOW,
    env: () => KEY,
    sleep: (ms) => (waits.push(ms), Promise.resolve()),
  });
  assertEquals(f.calls.length, TM_MAX_PAGES);
  assertEquals(r.events.length, TM_MAX_PAGES);
  assert(waits.length >= 1 && waits.every((w) => w > 0 && w <= 220));
});

Deno.test("an error never carries the key", async () => {
  const f = fakeFetch({
    "https://app.ticketmaster.com/*": () => {
      throw new Error(`failed to connect to https://app.ticketmaster.com/x?apikey=${KEY}`);
    },
  });
  const r = await ticketmasterAdapter(src, { fetch: f, now: NOW, env: () => KEY });
  assert(r.error?.includes("***"));
  assert(!r.error?.includes(KEY));
  const denied = fakeFetch({ "https://app.ticketmaster.com/*": { status: 401 } });
  assertEquals(
    (await ticketmasterAdapter(src, { fetch: denied, now: NOW, env: () => KEY })).error,
    "ticketmaster: HTTP 401",
  );
});

Deno.test("eventFromTm refuses what it cannot place in time", () => {
  assertEquals(eventFromTm({ name: "x", url: "https://t.example/x", dates: { start: {} } }, src), null);
  assertEquals(eventFromTm({ name: "", url: "https://t.example/x" }, src), null);
});
