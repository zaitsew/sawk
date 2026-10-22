// End to end on an in-memory Postgres: sources in, events and feed out, fetch stubbed.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { testDb } from "../_shared/testdb.ts";
import { fakeFetch } from "../_shared/ingest/testing.ts";
import { runIngest } from "./ingest.ts";

const NOW = new Date("2026-10-23T10:00:00Z");
const USER = "11111111-1111-4111-8111-111111111111";

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SAWk test//EN
BEGIN:VEVENT
UID:a1@test
DTSTART;TZID=Europe/Madrid:20261024T200000
DTEND;TZID=Europe/Madrid:20261024T220000
SUMMARY:Jazz Night
LOCATION:Jimmy Glass
URL:https://calendar.test/jazz
DESCRIPTION:Short.
END:VEVENT
BEGIN:VEVENT
UID:a2@test
DTSTART;TZID=Europe/Madrid:20261026T190000
SUMMARY:Python Meetup for developers
LOCATION:Las Naves
URL:https://calendar.test/python
END:VEVENT
BEGIN:VEVENT
UID:a3@test
DTSTART;TZID=Europe/Madrid:20240101T190000
SUMMARY:Long gone
URL:https://calendar.test/old
END:VEVENT
END:VCALENDAR`;

const jsonld = (events: unknown[]) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(events)}</script></head><body></body></html>`;

const HTML = jsonld([
  {
    "@type": "MusicEvent",
    name: "Jazz Night",
    startDate: "2026-10-24T20:00:00+02:00",
    url: "https://tickets.test/jazz",
    description:
      "Four musicians play standards, with a long enough text to win the merge over the calendar's short one.",
    location: { "@type": "Place", name: "Jimmy Glass", address: "Carrer de Prova 1, Valencia" },
    offers: { "@type": "Offer", price: "12", priceCurrency: "EUR" },
  },
  {
    "@type": "Event",
    name: "Gallery Opening",
    startDate: "2026-10-28T19:00:00+01:00",
    url: "https://tickets.test/gallery",
    location: { "@type": "Place", name: "Sala Prueba" },
    isAccessibleForFree: true,
  },
]);

async function setup() {
  const t = await testDb();
  await t.sql`delete from sawk.sources`; // the migrations seed the real sources; these tests bring their own
  const ins = (kind: string, url: string, label: string, over: { active?: boolean; city?: string } = {}) =>
    t.sql`insert into sawk.sources (city, country, kind, url, label, active)
          values (${over.city ?? "Valencia"}, 'ES', ${kind}, ${url}, ${label}, ${over.active ?? true}) returning id`;
  const ids = {
    ics: (await ins("ics", "https://calendar.test/feed.ics", "Calendar"))[0].id as string,
    ld: (await ins("jsonld", "https://tickets.test/agenda", "Tickets"))[0].id as string,
    tm: (await ins("ticketmaster", "ticketmaster:city=Valencia&countryCode=ES", "Ticketmaster"))[0].id as string,
    web: (await ins("web", "https://visit.test/agenda", "Agenda page"))[0].id as string,
    off: (await ins("ics", "https://off.test/feed.ics", "Switched off", { active: false }))[0].id as string,
    bad: (await ins("ics", "https://broken.test/feed.ics", "Broken"))[0].id as string,
  };
  await t.sql`insert into sawk.profiles (user_id, home_city, home_country, home_tz, likes)
              values (${USER}::uuid, 'Valencia', 'ES', 'Europe/Madrid', ${t.sql.array(["jazz"])}::text[])`;
  const f = fakeFetch({
    "https://calendar.test/feed.ics": { body: ICS, type: "text/calendar" },
    "https://tickets.test/robots.txt": { status: 404 },
    "https://tickets.test/agenda": { body: HTML, type: "text/html" },
    "https://broken.test/feed.ics": { status: 500 },
  });
  return { ...t, ids, f };
}

Deno.test("ingest: events from two sources, deduped; a failing source and a missing key do not stop the run", async () => {
  const { sql, close, ids, f } = await setup();
  const out =
    (await runIngest(sql, { now: NOW, fetch: f, env: () => undefined, politeDelayMs: 0, allowHost: () => true }))!;

  const byId = Object.fromEntries(out.sources.map((s) => [s.id, s]));
  assertEquals(Object.keys(byId).sort(), [ids.ics, ids.ld, ids.tm, ids.bad].sort()); // web and inactive are not read
  assertEquals([byId[ids.ics].events, byId[ids.ld].events], [2, 2]); // the 2024 event is dropped
  assertEquals(byId[ids.tm].skipped, true);
  assertEquals(byId[ids.bad].error, "HTTP 500");
  assertEquals(out.status, "partial");
  assertEquals(out.eventsAdded, 3); // jazz once, python, gallery

  const events =
    await sql`select title, venue, price_min, description, category, seen from sawk.events order by starts_at`;
  assertEquals(events.map((e) => e.title), ["Jazz Night", "Python Meetup for developers", "Gallery Opening"]);
  const jazz = events[0];
  assertEquals(jazz.venue, "Jimmy Glass");
  assertEquals(Number(jazz.price_min), 12); // from the second source
  assert((jazz.description as string).startsWith("Four musicians")); // the richer text won
  assertEquals(
    (jazz.seen as { via: string }[]).map((s) => s.via).sort(),
    [`ics:${ids.ics}`, `jsonld:${ids.ld}`].sort(),
  );

  const srcs = await sql`select id, last_ok_at, last_error, last_count from sawk.sources`;
  const row = (id: string) => srcs.find((s) => s.id === id)!;
  assert(row(ids.ics).last_ok_at && row(ids.ics).last_error === null && row(ids.ics).last_count === 2);
  assertEquals([row(ids.bad).last_ok_at, row(ids.bad).last_error], [null, "HTTP 500"]);
  assertEquals([row(ids.tm).last_ok_at, row(ids.tm).last_error], [null, "no key"]);
  assertEquals([row(ids.web).last_ok_at, row(ids.web).last_count, row(ids.off).last_ok_at], [null, null, null]);

  const runs =
    await sql`select agent, user_id, status, events_added, events_seen, ranked, cities, finished_at, notes from sawk.runs`;
  assertEquals(runs.length, 1);
  assertEquals([runs[0].agent, runs[0].user_id, runs[0].status, runs[0].events_added, runs[0].events_seen], [
    "ingest",
    null,
    "partial",
    3,
    4,
  ]);
  assertEquals(runs[0].cities, ["Valencia"]);
  assert(runs[0].finished_at);
  assert((runs[0].notes as string).includes("HTTP 500"));
  await close();
});

Deno.test("ingest: the fallback rank fills the feed, and a second run keeps an agent's rank and the person's state", async () => {
  const { sql, close, f } = await setup();
  const first =
    (await runIngest(sql, { now: NOW, fetch: f, env: () => undefined, politeDelayMs: 0, allowHost: () => true }))!;
  assertEquals([first.rankedUsers, first.ranked], [1, 3]);
  const feed =
    await sql`select e.title, f.ranked_by, f.score, f.reason from sawk.feed f join sawk.events e on e.id = f.event_id
                         where f.user_id = ${USER}::uuid order by f.score desc`;
  assertEquals(feed[0].title, "Jazz Night");
  assertEquals(feed[0].ranked_by, "fallback");
  assert(String(feed[0].reason).includes("jazz"));

  const [jazz] = await sql`select id from sawk.events where title = 'Jazz Night'`;
  const [gallery] = await sql`select id from sawk.events where title = 'Gallery Opening'`;
  await sql`update sawk.feed set score = 0.97, reason = 'Your agent picked it', ranked_by = 'agent:run-1', state = 'going'
            where user_id = ${USER}::uuid and event_id = ${jazz.id as string}`;
  await sql`update sawk.feed set state = 'saved' where user_id = ${USER}::uuid and event_id = ${gallery.id as string}`;

  const second = (await runIngest(sql, {
    now: new Date(NOW.getTime() + 86_400_000),
    fetch: f,
    env: () => undefined,
    politeDelayMs: 0,
    allowHost: () => true,
  }))!;
  assertEquals(second.eventsAdded, 0);
  const [mine] =
    await sql`select score, reason, ranked_by, state from sawk.feed where user_id = ${USER}::uuid and event_id = ${jazz
      .id as string}`;
  assertEquals([Number(mine.score), mine.reason, mine.ranked_by, mine.state], [
    0.97,
    "Your agent picked it",
    "agent:run-1",
    "going",
  ]);
  const [kept] = await sql`select state, ranked_by from sawk.feed where user_id = ${USER}::uuid and event_id = ${gallery
    .id as string}`;
  assertEquals([kept.state, kept.ranked_by], ["saved", "fallback"]);
  assertEquals((await sql`select count(*)::int as n from sawk.runs`)[0].n, 2);
  assertEquals((await sql`select count(*)::int as n from sawk.events`)[0].n, 3);
  await close();
});

Deno.test("ingest: one source by id; an unknown or non-machine source is null; rank can be switched off", async () => {
  const { sql, close, ids, f } = await setup();
  const one = (await runIngest(sql, {
    now: NOW,
    fetch: f,
    env: () => undefined,
    politeDelayMs: 0,
    allowHost: () => true,
    sourceId: ids.ics,
    rank: false,
  }))!;
  assertEquals(one.sources.map((s) => s.id), [ids.ics]);
  assertEquals([one.status, one.ranked], ["ok", 0]);
  assertEquals((await sql`select count(*)::int as n from sawk.feed`)[0].n, 0);
  assertEquals(await runIngest(sql, { now: NOW, fetch: f, sourceId: ids.web }), null);
  assertEquals(await runIngest(sql, { now: NOW, fetch: f, sourceId: "99999999-9999-4999-8999-999999999999" }), null);
  await close();
});

Deno.test("ingest: with a Ticketmaster key the API source is read", async () => {
  const { sql, close, ids } = await setup();
  const tm = JSON.stringify({
    _embedded: {
      events: [{
        name: "Arena Show",
        url: "https://tm.test/e/1",
        dates: { start: { dateTime: "2026-11-12T20:00:00Z" }, timezone: "Europe/Madrid" },
        classifications: [{ segment: { name: "Music" } }],
        _embedded: { venues: [{ name: "Arena Prueba", city: { name: "Valencia" } }] },
      }],
    },
    page: { totalPages: 1 },
  });
  const f = fakeFetch({ "https://app.ticketmaster.com/*": { body: tm, type: "application/json" } });
  const out = (await runIngest(sql, {
    now: NOW,
    fetch: f,
    env: (k) => (k === "TICKETMASTER_API_KEY" ? "k" : undefined),
    politeDelayMs: 0,
    allowHost: () => true,
    sourceId: ids.tm,
  }))!;
  assertEquals([out.status, out.eventsAdded], ["ok", 1]);
  assertEquals((await sql`select title from sawk.events`)[0].title, "Arena Show");
  await close();
});

Deno.test("ingest: all sources failing is a failed run", async () => {
  const { sql, close, ids } = await setup();
  const f = fakeFetch({});
  const out =
    (await runIngest(sql, { now: NOW, fetch: f, politeDelayMs: 0, allowHost: () => true, sourceId: ids.bad }))!;
  assertEquals(out.status, "failed");
  assertEquals((await sql`select status from sawk.runs`)[0].status, "failed");
  await close();
});

Deno.test("ingest: a source on a host outside the allow-list is skipped, not failed, and never fetched", async () => {
  const { sql, close, ids } = await setup();
  const [odd] = await sql`insert into sawk.sources (city, country, kind, url, label)
                          values ('Valencia', 'ES', 'ics', 'https://odd.example/feed.ics', 'Somewhere else') returning id`;
  const f = fakeFetch({ "https://odd.example/feed.ics": { body: ICS, type: "text/calendar" } });
  // The default allow-list, as in production.
  const out = (await runIngest(sql, {
    now: NOW,
    fetch: f,
    env: () => undefined,
    politeDelayMs: 0,
    rank: false,
    sourceId: odd.id as string,
  }))!;
  assertEquals(out.sources[0].skipped, true);
  assertEquals(out.sources[0].error, "host not on the ingest allow-list (agents can still read it)");
  assertEquals(f.calls, []);
  assertEquals(out.status, "ok"); // a skipped source does not make the run partial or failed
  const [row] = await sql`select last_ok_at, last_error from sawk.sources where id = ${odd.id as string}::uuid`;
  assertEquals([row.last_ok_at, row.last_error], [
    null,
    "host not on the ingest allow-list (agents can still read it)",
  ]);
  // The seeded kind of host passes the default list.
  const listed = (await sql`insert into sawk.sources (city, country, kind, url, label)
                            values ('Valencia', 'ES', 'ics', 'https://www.meetup.com/x/events/ical/', 'Listed') returning id`)[
    0
  ].id as string;
  const g = fakeFetch({ "https://www.meetup.com/x/events/ical/": { body: ICS, type: "text/calendar" } });
  const ok = (await runIngest(sql, {
    now: NOW,
    fetch: g,
    env: () => undefined,
    politeDelayMs: 0,
    rank: false,
    sourceId: listed,
  }))!;
  assertEquals([ok.sources[0].skipped, ok.sources[0].error, ok.eventsAdded], [undefined, undefined, 2]);
  void ids;
  await close();
});
