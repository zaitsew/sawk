import { assert, assertEquals } from "jsr:@std/assert@1";
import { collectEvents, extractJsonLd, jsonldAdapter, parseJsonLdPage, parseLdDate } from "./jsonld.ts";
import { finalizeEvents } from "./normalize.ts";
import { fakeFetch, fixture, NOW, source } from "./testing.ts";

const PAGE = "https://venue.fixture.test/agenda";
const src = source({ kind: "jsonld", url: PAGE });

async function events() {
  return parseJsonLdPage(await fixture("events.html"), PAGE, src).events;
}
const find = async (title: string) => (await events()).find((e) => e.title === title)!;

Deno.test("every ld+json block is read; one that does not parse is skipped", async () => {
  const blocks = extractJsonLd(await fixture("events.html"));
  assertEquals(blocks.length, 3); // graph, item list, food event; the broken one is gone
  assert(collectEvents(blocks).length >= 7);
});

Deno.test("MusicEvent in a @graph: entities, relative urls, price with decimal comma, offset time, locality", async () => {
  const e = await find("Café & Jazz Trio");
  assertEquals(e.startsAt, "2026-10-25T19:30:00Z"); // 20:30+01:00
  assertEquals(e.endsAt, "2026-10-25T21:30:00Z");
  assertEquals(e.category, "music");
  assertEquals(e.url, "https://venue.fixture.test/events/cafe-jazz");
  assertEquals(e.imageUrl, "https://venue.fixture.test/img/jazz.jpg");
  assertEquals(e.ticketUrl, "https://tickets.fixture.test/jazz");
  assertEquals([e.priceMin, e.priceMax, e.currency, e.isFree], [12.5, 12.5, "EUR", false]);
  assertEquals(e.venue, "Blue Room");
  assertEquals(e.address, "Carrer de Prova 1, 46001, València");
  assertEquals(e.city, "Valencia"); // "València" is the source's city
  assertEquals([e.lat, e.lon], [39.47, -0.37]);
  assertEquals(e.description, "Three musicians.\nDoors at 20:00.");
  assertEquals(e.cancelled, false);
});

Deno.test("ExhibitionEvent: date-only is all-day, the end day is inclusive, free, address-like place name", async () => {
  const e = await find("Light and Shadow");
  assertEquals(e.allDay, true);
  assertEquals(e.startsAt, "2026-09-30T22:00:00Z"); // Oct 1 00:00 in Madrid (CEST)
  assertEquals(e.endsAt, "2026-12-31T23:00:00Z"); // over at the end of Dec 31
  assertEquals(e.isFree, true);
  assertEquals(e.category, "art");
  assertEquals(e.venue, "Museo Prueba");
});

Deno.test("cancelled status, floating time, multiple types", async () => {
  const e = await find("Called Off Party");
  assertEquals(e.cancelled, true);
  assertEquals(e.startsAt, "2026-10-30T21:00:00Z"); // 22:00 local, no offset written
});

Deno.test("ItemList: ranges of offers, venue suffix stripped from the title, other city kept, online dropped", async () => {
  const all = await events();
  const hamlet = all.find((e) => e.title === "Hamlet in a Box")!;
  assertEquals([hamlet.priceMin, hamlet.priceMax], [10, 25]);
  assertEquals(hamlet.category, "theatre");
  assertEquals(hamlet.startsAt, "2026-11-07T18:00:00Z");
  const game = all.find((e) => e.title === "Valencia Basket vs Test BC")!;
  assertEquals(game.venue, "Pabellon Prueba");
  assertEquals(game.category, "sport");
  assertEquals(all.find((e) => e.title === "Madrid Only Show")!.city, "Madrid");
  assert(!all.some((e) => e.title.startsWith("Webinar")));
});

Deno.test("location as a string is an address; an end before the start is dropped", async () => {
  const e = await find("Paella Workshop");
  assertEquals(e.address, "Carrer de Prova 9, Valencia");
  assertEquals(e.venue, null);
  assertEquals(e.endsAt, null);
  assertEquals(e.category, "food");
  assertEquals(e.description, "Learn to cook paella. Bring an apron.");
});

Deno.test("dates: offsets, floating zone, date only", () => {
  assertEquals(parseLdDate("2026-10-25T20:30:00+0100", null), {
    ms: Date.parse("2026-10-25T19:30:00Z"),
    dateOnly: false,
  });
  assertEquals(parseLdDate("2026-10-28T18:30:00.000Z", null), {
    ms: Date.parse("2026-10-28T18:30:00Z"),
    dateOnly: false,
  });
  assertEquals(parseLdDate("2026-10-30T22:00", "Europe/Madrid")!.ms, Date.parse("2026-10-30T21:00:00Z"));
  assertEquals(parseLdDate("2026-10-30", "Europe/Madrid"), { ms: Date.parse("2026-10-29T23:00:00Z"), dateOnly: true });
  assertEquals(parseLdDate("soon", null), null);
  assertEquals(parseLdDate("", null), null);
});

Deno.test("shared placeholder coordinates are dropped", () => {
  const ev = (n: number) => ({
    "@type": "Event",
    name: `Show ${n}`,
    startDate: "2026-11-01T20:00:00Z",
    location: { "@type": "Place", name: `Venue ${n}`, geo: { latitude: "39.4", longitude: "-0.37" } },
  });
  const html = `<script type="application/ld+json">${JSON.stringify([ev(1), ev(2), ev(3)])}</script>`;
  const out = parseJsonLdPage(html, PAGE, src).events;
  assertEquals(out.map((e) => e.lat), [null, null, null]);
});

Deno.test("finalize: the shared rules on top of the adapter's events", async () => {
  const raw = await events();
  const fin = await finalizeEvents(raw, src, NOW);
  const titles = fin.events.map((e) => e.title);
  assert(titles.includes("Café & Jazz Trio"));
  assert(titles.includes("Light and Shadow")); // started in September, runs to December
  assert(fin.events.every((e) => e.id.startsWith("ev_")));
});

Deno.test("adapter: robots.txt is honoured and fetched once per host", async () => {
  const html = await fixture("events.html");
  const robots = await fixture("robots.txt");
  const f = fakeFetch({
    "https://venue.fixture.test/robots.txt": robots,
    [PAGE]: { body: html, type: "text/html" },
    "https://venue.fixture.test/private/x": { body: html, type: "text/html" },
  });
  const ctx = { fetch: f, now: NOW, env: () => undefined, cache: new Map<string, unknown>() };
  const ok = await jsonldAdapter(src, ctx);
  assertEquals(ok.error, undefined);
  assertEquals(ok.events.length, 7);
  const blocked = await jsonldAdapter({ ...src, url: "https://venue.fixture.test/private/x" }, ctx);
  assertEquals(blocked.events.length, 0);
  assertEquals(blocked.error, "disallowed by robots.txt of venue.fixture.test");
  assertEquals(f.calls.filter((u) => u.endsWith("/robots.txt")).length, 1);
});

Deno.test("adapter: a page without JSON-LD says so", async () => {
  const f = fakeFetch({
    "https://venue.fixture.test/robots.txt": { status: 404 },
    [PAGE]: { body: "<html>hi</html>", type: "text/html" },
  });
  const r = await jsonldAdapter(src, { fetch: f, now: NOW, env: () => undefined });
  assertEquals(r, { events: [], error: "no JSON-LD on the page" });
});

Deno.test("adapter: a page over the size cap is refused", async () => {
  const big = "x".repeat(3 * 1024 * 1024 + 10);
  const f = fakeFetch({
    "https://venue.fixture.test/robots.txt": { status: 404 },
    [PAGE]: { body: big, type: "text/html" },
  });
  const r = await jsonldAdapter(src, { fetch: f, now: NOW, env: () => undefined });
  assertEquals(r.events.length, 0);
  assert(r.error?.startsWith("response too large"));
});
