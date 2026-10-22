import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  expandRule,
  icsAdapter,
  parseDuration,
  parseIcs,
  parseRule,
  splitLocation,
  unescapeText,
  unfold,
} from "./ics.ts";
import { finalizeEvents } from "./normalize.ts";
import { fakeFetch, fixture, NOW, source } from "./testing.ts";

const OPTS = {
  now: NOW,
  city: "Valencia",
  country: "ES",
  sourceUrl: "https://venue.fixture.test/feed.ics",
  tz: "Europe/Madrid",
};

async function parsed() {
  return parseIcs(await fixture("events.ics"), OPTS).events;
}
const byTitle = <T extends { title: string }>(events: T[], t: string) => events.filter((e) => e.title === t);

Deno.test("unfold joins folded lines and unescapes text", () => {
  assertEquals(unfold("A:one\r\n two\r\nB:x\n\ty"), ["A:onetwo", "B:xy"]);
  assertEquals(unescapeText("a\\, b\; c\\nd \\\\ e"), "a, b; c\nd \\ e");
});

Deno.test("TZID event: instant, zone, text, location, url, geo, tags", async () => {
  const [jazz] = byTitle(await parsed(), "Jazz Night at the Blue Room");
  assertEquals(jazz.startsAt, "2026-10-24T19:30:00Z"); // 21:30 CEST
  assertEquals(jazz.endsAt, "2026-10-24T21:30:00Z");
  assertEquals(jazz.tz, "Europe/Madrid");
  assertEquals(jazz.allDay, false);
  assertEquals(jazz.venue, "Blue Room");
  assertEquals(jazz.address, "Carrer de Prova, 1, Valencia");
  assertEquals(jazz.url, "https://venue.fixture.test/events/jazz-night");
  assertEquals([jazz.lat, jazz.lon], [39.4699, -0.3763]);
  assertEquals(jazz.tags, ["jazz", "live music"]);
  assert(jazz.description?.startsWith("Quartet, live.\nSecond line with a semicolon; and a long text that is folded"));
  assert(!jazz.description?.includes("Reminder")); // the VALARM's DESCRIPTION does not leak
});

Deno.test("all-day event: date-only start, exclusive end, free from the text", async () => {
  const [market] = byTitle(await parsed(), "Autumn Market");
  assertEquals(market.allDay, true);
  assertEquals(market.startsAt, "2026-10-31T23:00:00Z"); // midnight of Nov 1 in Madrid (CET after Oct 25)
  assertEquals(market.endsAt, "2026-11-02T23:00:00Z");
  assertEquals(market.address, "Plaza del Mercado"); // a street-like name is an address
  const fin = await finalizeEvents([market], source(), NOW);
  assertEquals(fin.events[0].isFree, true);
});

Deno.test("weekly RRULE with BYDAY, EXDATE and a DST change", async () => {
  const lx = byTitle(await parsed(), "Language Exchange");
  // Oct 20 is over; Oct 27 is the first Tuesday to come; Thu Oct 29 is excluded.
  assertEquals(lx[0].startsAt, "2026-10-27T18:00:00Z"); // 19:00 CET (DST ended Oct 25)
  assertEquals(lx[1].startsAt, "2026-11-03T18:00:00Z");
  assertEquals(lx[2].startsAt, "2026-11-05T18:00:00Z");
  assert(!lx.some((e) => e.startsAt === "2026-10-29T18:00:00Z"));
  assertEquals(lx[0].venue, "Cafe Prueba");
  assertEquals(lx[0].address, "Carrer de Prova 5, Valencia");
  // Nothing past the 60-day horizon (Dec 22), and every occurrence on a Tuesday or Thursday.
  for (const e of lx) {
    assert(Date.parse(e.startsAt) <= NOW.getTime() + 60 * 86_400_000);
    assert([2, 4].includes(new Date(e.startsAt).getUTCDay()));
  }
  assertEquals(lx.length, 15); // 8 Tuesdays (to Dec 15) and 7 Thursdays (to Dec 17), minus Oct 29
});

Deno.test("an override replaces its occurrence; COUNT counts from DTSTART", async () => {
  const events = await parsed();
  const yoga = events.filter((e) => e.title.startsWith("Yoga"));
  // Weekly from Wed Oct 21, COUNT=6: Oct 21 (over), Oct 28, Nov 4 (overridden), Nov 11, Nov 18, Nov 25.
  assertEquals(yoga.map((e) => `${e.title}|${e.startsAt}`), [
    "Yoga in the Park|2026-10-28T17:00:00Z",
    "Yoga in the Park|2026-11-11T17:00:00Z",
    "Yoga in the Park|2026-11-18T17:00:00Z",
    "Yoga in the Park|2026-11-25T17:00:00Z",
    "Yoga in the Park (special evening)|2026-11-04T19:00:00Z",
  ]);
  assertEquals(yoga[0].endsAt, "2026-10-28T18:00:00Z"); // DURATION:PT1H

  const monday = byTitle(events, "First Monday Breakfast");
  // First Mondays: Oct 5 (counted, over), Nov 2, Dec 7.
  assertEquals(monday.map((e) => e.startsAt), ["2026-11-02T09:00:00Z", "2026-12-07T09:00:00Z"]);
});

Deno.test("cancelled, UTC, floating, online, unsupported rule, bad events", async () => {
  const events = await parsed();
  assertEquals(byTitle(events, "Cancelled Concert")[0].cancelled, true);
  assertEquals(byTitle(events, "Cancelled Concert")[0].startsAt, "2026-10-26T18:00:00Z");
  assertEquals(byTitle(events, "Floating Time Talk")[0].startsAt, "2026-10-27T19:00:00Z"); // 20:00 in the source's zone
  assertEquals(byTitle(events, "Online Webinar").length, 0);
  assertEquals(byTitle(events, "No Start Date").length, 0);
  // YEARLY is outside what is expanded: read once, as written.
  const gala = byTitle(events, "Yearly Gala");
  assertEquals(gala.length, 1);
  assertEquals(gala[0].startsAt, "2026-11-10T19:00:00Z");
  // The old event is read, then dropped by the shared "already over" rule.
  const fin = await finalizeEvents(events, source(), NOW);
  assert(!fin.events.some((e) => e.title === "Long Gone"));
  assert(fin.events.some((e) => e.title === "Cancelled Concert" && e.cancelled));
});

Deno.test("rules: parse, refuse the unsupported, expand", () => {
  assertEquals(parseRule("FREQ=YEARLY"), null);
  assertEquals(parseRule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR"), null);
  assertEquals(parseRule("FREQ=DAILY;BYDAY=MO"), null);
  assertEquals(parseRule("FREQ=WEEKLY;BYDAY=2MO"), null);
  assertEquals(parseRule("FREQ=WEEKLY;INTERVAL=0"), null);
  const rule = parseRule("FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3")!;
  const start = Date.UTC(2026, 0, 31, 9);
  const walls = expandRule(start, rule, Date.UTC(2027, 0, 1), (u) => u.wall, (w) => w);
  // The 31st exists in Jan, Mar, May: COUNT=3 stops there.
  assertEquals(walls.map((w) => new Date(w).toISOString().slice(0, 10)), ["2026-01-31", "2026-03-31", "2026-05-31"]);
  const last = parseRule("FREQ=MONTHLY;BYDAY=-1FR")!;
  const fr = expandRule(Date.UTC(2026, 9, 30, 20), last, Date.UTC(2027, 0, 1), (u) => u.wall, (w) => w);
  assertEquals(fr.map((w) => new Date(w).toISOString().slice(0, 10)), ["2026-10-30", "2026-11-27", "2026-12-25"]);
});

Deno.test("durations and locations", () => {
  assertEquals(parseDuration("PT1H30M"), 5_400_000);
  assertEquals(parseDuration("P1DT2H"), 93_600_000);
  assertEquals(parseDuration("P1W"), 604_800_000);
  assertEquals(parseDuration("nonsense"), null);
  assertEquals(splitLocation("Teatro Principal, Carrer de les Barques 15, Valencia"), {
    venue: "Teatro Principal",
    address: "Carrer de les Barques 15, Valencia",
    online: false,
  });
  assertEquals(splitLocation("Carrer de Baja, 28, Valencia"), {
    venue: null,
    address: "Carrer de Baja, 28, Valencia",
    online: false,
  });
  assertEquals(splitLocation("Jimmy Glass").venue, "Jimmy Glass");
  assertEquals(splitLocation("Online event").online, true);
  assertEquals(splitLocation("https://meet.example.test/x").online, true);
});

Deno.test("adapter: fetches, returns events; failures come back as error, never thrown", async () => {
  const body = await fixture("events.ics");
  const ok = await icsAdapter(source(), {
    fetch: fakeFetch({ "https://venue.fixture.test/feed.ics": body }),
    now: NOW,
    env: () => undefined,
  });
  assertEquals(ok.error, undefined);
  assert(ok.events.length > 20);

  const notFound = await icsAdapter(source(), { fetch: fakeFetch({}), now: NOW, env: () => undefined });
  assertEquals(notFound, { events: [], error: "HTTP 404" });

  const html = await icsAdapter(source(), {
    fetch: fakeFetch({ "https://venue.fixture.test/feed.ics": "<html></html>" }),
    now: NOW,
    env: () => undefined,
  });
  assertEquals(html.error, "not an iCalendar feed");

  const boom = await icsAdapter(source(), {
    fetch: (() => Promise.reject(new Error("dns"))) as typeof fetch,
    now: NOW,
    env: () => undefined,
  });
  assertEquals(boom.events.length, 0);
  assert(boom.error?.includes("dns"));
});
