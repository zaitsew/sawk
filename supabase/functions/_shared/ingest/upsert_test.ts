import { assert, assertEquals } from "jsr:@std/assert@1";
import { testDb } from "../testdb.ts";
import { finalizeEvents, type ReadyEvent } from "./normalize.ts";
import type { Sql } from "../db.ts";
import {
  collapseDuplicates,
  coreTitle,
  type Merged,
  mergeEvent,
  sameVenue,
  type Sighted,
  upsertEvents,
  variantOf,
} from "./upsert.ts";
import { NOW, source } from "./testing.ts";
import type { IngestEvent } from "./types.ts";

const raw = (over: Partial<IngestEvent> = {}): IngestEvent => ({
  title: "Jazz Night",
  startsAt: "2026-10-24T18:00:00Z",
  url: "https://a.test/jazz",
  venue: "Jimmy Glass",
  city: "Valencia",
  ...over,
} as IngestEvent);

async function ready(over: Partial<IngestEvent> = {}): Promise<ReadyEvent> {
  const { events } = await finalizeEvents([raw(over)], source(), NOW);
  return events[0];
}

Deno.test("merge: a first sighting becomes the row", async () => {
  const m = mergeEvent(null, await ready({ description: "d" }), "ics:1", NOW);
  assertEquals(m.seen, [{ via: "ics:1", url: "https://a.test/jazz", at: NOW.toISOString() }]);
  assertEquals(m.title, "Jazz Night");
});

Deno.test("merge: richer wins, nothing is blanked, sightings deduped by url", async () => {
  const first = mergeEvent(null, await ready({ description: "short", imageUrl: "https://a.test/i.jpg" }), "ics:1", NOW);
  const second = await ready({
    url: "https://b.test/jazz",
    description: "a much longer description of the evening",
    priceMin: 12,
    priceMax: 12,
    currency: "EUR",
    address: "Carrer de Prova 1",
    lat: 39.4,
    lon: -0.3,
    tags: ["jazz"],
  });
  const m = mergeEvent(first, second, "jsonld:2", NOW);
  assertEquals(m.description, "a much longer description of the evening");
  assertEquals(m.imageUrl, "https://a.test/i.jpg"); // the second had none: kept
  assertEquals([m.priceMin, m.currency, m.address, m.lat], [12, "EUR", "Carrer de Prova 1", 39.4]);
  assertEquals(m.url, "https://a.test/jazz"); // the first page stays the event's own
  assertEquals(m.seen.map((s) => s.via), ["ics:1", "jsonld:2"]);
  const again = mergeEvent(m, second, "jsonld:2", NOW);
  assertEquals(again.seen.length, 2);
});

Deno.test("merge: the source that saw it before decides a change of time; another cannot move it", async () => {
  const first = mergeEvent(null, await ready(), "ics:1", NOW);
  const moved = await ready({ startsAt: "2026-10-24T19:00:00Z" });
  assertEquals(mergeEvent(first, moved, "ics:1", NOW).startsAt, "2026-10-24T19:00:00Z");
  assertEquals(mergeEvent(first, moved, "jsonld:2", NOW).startsAt, "2026-10-24T18:00:00Z");
  // a timed reading beats an all-day one
  const allDay: Merged = mergeEvent(
    null,
    await ready({ allDay: true, startsAt: "2026-10-23T22:00:00Z" }),
    "jsonld:2",
    NOW,
  );
  const timed = mergeEvent(allDay, await ready(), "ics:1", NOW);
  assertEquals([timed.allDay, timed.startsAt], [false, "2026-10-24T18:00:00Z"]);
});

Deno.test("merge: cancelled sticks unless the source that said so changes its mind", async () => {
  const cancelled = mergeEvent(null, await ready({ cancelled: true }), "ics:1", NOW);
  assertEquals(mergeEvent(cancelled, await ready(), "jsonld:2", NOW).cancelled, true);
  assertEquals(mergeEvent(cancelled, await ready(), "ics:1", NOW).cancelled, false);
});

Deno.test("upsert: insert, then update; a cancelled event never seen before is skipped", async () => {
  const { sql, close } = await testDb();
  const a = await ready();
  const c = await ready({ title: "Never seen", cancelled: true });
  assertEquals(await upsertEvents(sql, [a, c], "ics:1", NOW), { added: 1, updated: 0, skipped: 1 });
  assertEquals(await upsertEvents(sql, [a], "ics:1", NOW), { added: 0, updated: 1, skipped: 0 });
  const rows = await sql`select id, title, venue, category, seen, first_seen_at, last_seen_at from sawk.events`;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, a.id);
  assertEquals((rows[0].seen as unknown[]).length, 1);
  await close();
});

Deno.test("upsert: same id from two sources is one row; a source without a venue joins the one that has it", async () => {
  const { sql, close } = await testDb();
  await upsertEvents(sql, [await ready()], "ics:1", NOW);
  // identical id (same title, day, venue, city)
  await upsertEvents(sql, [await ready({ url: "https://b.test/x", description: "from b" })], "jsonld:2", NOW);
  // no venue: a different id, the same event
  const noVenue = await ready({ venue: null, url: "https://c.test/y", priceMin: 10, currency: "EUR" });
  await upsertEvents(sql, [noVenue], "jsonld:3", NOW);
  const rows = await sql`select * from sawk.events`;
  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.venue, "Jimmy Glass");
  assertEquals(Number(r.price_min), 10);
  assertEquals(r.description, "from b");
  assertEquals((r.seen as { via: string }[]).map((s) => s.via).sort(), ["ics:1", "jsonld:2", "jsonld:3"]);
  // a different venue the same evening is a different event
  await upsertEvents(sql, [await ready({ venue: "Sala Rodrigo", url: "https://d.test/z" })], "jsonld:4", NOW);
  assertEquals((await sql`select count(*)::int as n from sawk.events`)[0].n, 2);
  await close();
});

Deno.test("upsert: an empty batch does nothing", async () => {
  const { sql, close } = await testDb();
  assertEquals(await upsertEvents(sql, [], "ics:1", NOW), { added: 0, updated: 0, skipped: 0 });
  assert((await sql`select 1 from sawk.events`).length === 0);
  await close();
});

Deno.test("merge: only a source that cancelled can un-cancel; the flag lives in the sighting", async () => {
  const a = mergeEvent(null, await ready({ cancelled: true }), "ics:1", NOW);
  assertEquals(a.seen[0].cancelled, true);
  // B has seen it before, not cancelled: it cannot clear A's cancellation.
  const b = mergeEvent(a, await ready({ url: "https://b.test/x" }), "jsonld:2", NOW);
  assertEquals(b.cancelled, true);
  assertEquals(b.seen.find((s) => s.via === "jsonld:2")?.cancelled, undefined);
  // B cancels too, then A takes it back: B still stands.
  const c = mergeEvent(b, await ready({ url: "https://b.test/x", cancelled: true }), "jsonld:2", NOW);
  const d = mergeEvent(c, await ready(), "ics:1", NOW);
  assertEquals(d.cancelled, true);
  assertEquals(d.seen.find((s) => s.via === "ics:1")?.cancelled, undefined);
  // Last one to take it back un-cancels.
  const e = mergeEvent(d, await ready({ url: "https://b.test/x" }), "jsonld:2", NOW);
  assertEquals(e.cancelled, false);
  // A cancellation nobody on record made (an agent, an older row) is not undone by a feed.
  const agent = { ...mergeEvent(null, await ready(), "agent:run-1", NOW), cancelled: true };
  assertEquals(mergeEvent(agent, await ready(), "ics:1", NOW).cancelled, true);
  assertEquals(mergeEvent(agent, await ready(), "agent:run-1", NOW).cancelled, true);
});

Deno.test("upsert: a cancellation survives the database round trip and the wrong source cannot clear it", async () => {
  const { sql, close } = await testDb();
  await upsertEvents(sql, [await ready()], "ics:1", NOW);
  await upsertEvents(sql, [await ready({ cancelled: true })], "ics:1", NOW);
  await upsertEvents(sql, [await ready({ url: "https://b.test/x" })], "jsonld:2", NOW);
  let [r] = await sql`select cancelled, seen from sawk.events`;
  assertEquals(r.cancelled, true);
  assertEquals((r.seen as { via: string; cancelled?: boolean }[]).filter((s) => s.cancelled).map((s) => s.via), [
    "ics:1",
  ]);
  await upsertEvents(sql, [await ready()], "ics:1", NOW);
  [r] = await sql`select cancelled from sawk.events`;
  assertEquals(r.cancelled, false);
  await close();
});

Deno.test("upsert: two sightings of one event in a single batch merge without error", async () => {
  const { sql, close } = await testDb();
  // The first inserts; the second has no venue and finds it through the in-batch cache.
  const withVenue = await ready({ category: "music" });
  const noVenue = await ready({ venue: null, url: "https://c.test/y", priceMin: 9, currency: "EUR" });
  assertEquals(await upsertEvents(sql, [withVenue, noVenue], "jsonld:3", NOW), { added: 1, updated: 1, skipped: 0 });
  const rows = await sql`select category, venue, price_min from sawk.events`;
  assertEquals(rows.length, 1);
  assertEquals([rows[0].category, rows[0].venue, Number(rows[0].price_min)], ["music", "Jimmy Glass", 9]);
  await close();
});

Deno.test("upsert: what another writer filled in after the first read survives", async () => {
  const { sql, close } = await testDb();
  const base = await ready();
  await upsertEvents(sql, [base], "ics:1", NOW);
  // An agent enriches the row after our candidate read but before our write: simulated inside the same transaction,
  // right after the window query returns.
  let fired = false;
  const wrapped = Object.assign(
    (strings: TemplateStringsArray, ...v: unknown[]) => sql(strings, ...v),
    sql,
    {
      begin: <T>(fn: (tx: Sql) => Promise<T>) =>
        sql.begin((tx) => {
          const spy = Object.assign(
            async (strings: TemplateStringsArray, ...v: unknown[]) => {
              const rows = await tx(strings, ...v);
              if (!fired && strings.join("?").includes("lower(city) = any")) {
                fired = true;
                await tx`update sawk.events set description = 'Written by an agent, long and careful', price_min = 15, image_url = 'https://agent.test/i.jpg'`;
              }
              return rows;
            },
            tx,
          ) as unknown as Sql;
          return fn(spy);
        }),
    },
  ) as unknown as Sql;
  await upsertEvents(wrapped, [await ready({ description: "short", priceMin: 40 })], "ics:1", NOW);
  assert(fired);
  const [r] = await sql`select description, price_min, image_url from sawk.events`;
  assertEquals(r.description, "Written by an agent, long and careful");
  assertEquals(Number(r.price_min), 15);
  assertEquals(r.image_url, "https://agent.test/i.jpg");
  await close();
});

// ---- title variants (shapes from the live Valencia pool, 2026-10-23) -------

Deno.test("core title: the city, a trailing year, 'tickets' and ' en <venue>' go; the act stays", () => {
  const core = (t: string, v: string | null) => coreTitle(t, v, "Valencia");
  assertEquals(core("Francisca Valenzuela en Loco Club, Valencia 2026", "El Loco Club"), "francisca valenzuela");
  assertEquals(core("Francisca Valenzuela", "El Loco Club"), "francisca valenzuela");
  assertEquals(core("Nanpa Básico en Auditorio Roig Arena, Valencia 2026", "Roig Arena"), "nanpa basico");
  assertEquals(core("Morat Valencia Tickets", "Roig Arena"), "morat");
  assertEquals(core("Morat in Valencia", "Auditorio Roig Arena"), "morat");
  assertEquals(core("ABHIR in València", null), "abhir");
  assertEquals(core("Glorysixvain en Valencia", "Sala La 3"), "glorysixvain");
  assertEquals(core("Digital Jove 2026", null), "digital jove");
  // " en " that is not the venue is part of the title
  assertEquals(core("Inglés en familia", "Biblioteca Central"), "ingles en familia");
  assertEquals(core("Candlelight: Queen & ABBA", "Ateneo Mercantil de Valencia"), "candlelight queen and abba");
});

Deno.test("same venue: one unknown, one inside the other, or a naming word in common", () => {
  assert(sameVenue("Auditorio - Roig Arena", "Roig Arena", "Valencia"));
  assert(sameVenue("Estadi Ciutat de Valencia", "Estadio Ciutat de Valencia", "Valencia"));
  assert(sameVenue(null, "Sala Moon", "Valencia"));
  assert(!sameVenue("Teatro de Yulia Vashchenko (ARIES)", "La Comedia stand up bar", "Valencia"));
  assert(!sameVenue("Sala Moon", "Sala Rodrigo", "Valencia"), "'sala' alone names no venue");
});

Deno.test("variant: equal cores match; a prefix matches only when it is the one candidate and close in time", () => {
  const at = (title: string, venue: string | null, startsAt = "2026-10-26T19:00:00Z", allDay = false): Sighted => ({
    title,
    venue,
    city: "Valencia",
    startsAt,
    allDay,
  });
  const songkick = at("Francisca Valenzuela", "El Loco Club");
  const allevents = at(
    "Francisca Valenzuela en Loco Club, Valencia 2026",
    "El Loco Club",
    "2026-10-25T22:00:00Z",
    true,
  );
  assertEquals(variantOf(allevents, [songkick]), songkick);
  assertEquals(variantOf(songkick, [allevents]), allevents);
  // Same title at another venue: two events.
  assertEquals(
    variantOf(at("Stand Up in Valencia", "La Comedia stand up bar"), [at("Stand Up", "Teatro Aries")]),
    undefined,
  );
  // Same venue and day, another show.
  const candle = at("Candlelight: Queen & ABBA", "Ateneo Mercantil");
  assertEquals(variantOf(at("Candlelight: La ley innata", "Ateneo Mercantil"), [candle]), undefined);
  // A prefix: one candidate matches; two (a festival and its workshops) match neither.
  const camilo = at("Michel Camilo", "Les Arts");
  assertEquals(variantOf(at("Michel Camilo Trio", "Les Arts", "2026-10-26T00:00:00Z", true), [camilo]), camilo);
  const umbrella = at("Digital Jove 2026", "UPV", "2026-11-05T00:00:00Z", true);
  const workshops = [
    at("Digital Jove 2026 - Pixel Art para la creación de videojuegos", "UPV", "2026-11-05T00:00:00Z", true),
    at("Digital Jove 2026 - Showroom XR", "UPV", "2026-11-05T00:00:00Z", true),
  ];
  assertEquals(variantOf(umbrella, workshops), undefined);
  // A short all-day title takes no longer one, even alone: an umbrella next to one of its workshops.
  assertEquals(variantOf(workshops[0], [umbrella]), undefined);
  assertEquals(variantOf(umbrella, [workshops[0]]), undefined);
  // Equal cores, both timed, hours apart: two performances.
  assertEquals(
    variantOf(at("Hamlet Valencia Tickets", "Teatre Talia", "2026-10-26T18:00:00Z"), [
      at("Hamlet", "Teatre Talia", "2026-10-26T09:00:00Z"),
    ]),
    undefined,
  );
  // Both timed and hours apart: a matinee is not the evening show.
  assertEquals(variantOf(at("Michel Camilo Trio", "Les Arts", "2026-10-26T11:00:00Z"), [camilo]), undefined);
});

const songkick = () =>
  ready({
    title: "Francisca Valenzuela",
    venue: "El Loco Club",
    startsAt: "2026-10-26T19:00:00Z",
    url: "https://sk.test/fv",
  });
const allevents = () =>
  ready({
    title: "Francisca Valenzuela en Loco Club, Valencia 2026",
    venue: "El Loco Club",
    allDay: true,
    startsAt: "2026-10-25T23:00:00Z", // midnight in Valencia (CET from the 25th)
    url: "https://ae.test/fv",
    priceMin: 22,
    currency: "EUR",
  });

Deno.test("upsert: a listing's longer title joins the event, in either order; the start time wins", async () => {
  for (const order of [[songkick, allevents], [allevents, songkick]]) {
    const { sql, close } = await testDb();
    await upsertEvents(sql, [await order[0]()], "jsonld:1", NOW);
    assertEquals(await upsertEvents(sql, [await order[1]()], "jsonld:2", NOW), { added: 0, updated: 1, skipped: 0 });
    const rows = await sql`select starts_at, all_day, price_min, seen from sawk.events`;
    assertEquals(rows.length, 1);
    assertEquals([new Date(rows[0].starts_at as string).toISOString(), rows[0].all_day], [
      "2026-10-26T19:00:00.000Z",
      false,
    ]);
    assertEquals(Number(rows[0].price_min), 22);
    assertEquals((rows[0].seen as unknown[]).length, 2);
    await close();
  }
});

Deno.test("upsert: two variants in one batch join the row; other shows at the venue stay apart", async () => {
  const { sql, close } = await testDb();
  await upsertEvents(
    sql,
    [await ready({ title: "Morat", venue: "Roig Arena", url: "https://sk.test/m" })],
    "jsonld:1",
    NOW,
  );
  const r = await upsertEvents(
    sql,
    [
      await ready({
        title: "Morat in Valencia",
        venue: "Auditorio Roig Arena",
        allDay: true,
        startsAt: "2026-10-23T22:00:00Z",
        url: "https://ae.test/m1",
      }),
      await ready({
        title: "Morat Valencia Tickets",
        venue: "Roig Arena",
        allDay: true,
        startsAt: "2026-10-23T22:00:00Z",
        url: "https://ae.test/m2",
      }),
      await ready({ title: "Candlelight: Queen & ABBA", venue: "Roig Arena", url: "https://ae.test/c" }),
    ],
    "jsonld:2",
    NOW,
  );
  assertEquals(r, { added: 1, updated: 2, skipped: 0 });
  assertEquals((await sql`select title from sawk.events order by title`).map((x) => x.title), [
    "Candlelight: Queen & ABBA",
    "Morat",
  ]);
  await close();
});

Deno.test("collapse: stored duplicates become one row; the person's state, rank and feedback move to it", async () => {
  const { sql, close } = await testDb();
  const USER = "11111111-1111-4111-8111-111111111111";
  // As the first ingest stored them: two rows, before the variant rule.
  const a = await allevents(), b = await songkick();
  for (const [e, via] of [[a, "jsonld:ae"], [b, "jsonld:sk"]] as const) {
    const m = mergeEvent(null, e, via, NOW);
    await sql`insert into sawk.events (id, title, starts_at, all_day, tz, city, venue, category, url, seen, price_min, currency, first_seen_at)
              values (${e.id}, ${m.title}, ${m.startsAt}::timestamptz, ${m.allDay}, ${m.tz}, ${m.city}, ${m.venue}, ${m.category},
                      ${m.url}, ${
      sql.json(m.seen)
    }::jsonb, ${m.priceMin}::numeric, ${m.currency}, ${NOW.toISOString()}::timestamptz)`;
  }
  const other = await ready({ title: "Candlelight: Queen & ABBA", venue: "El Loco Club", url: "https://x.test/c" });
  await upsertEvents(sql, [other], "jsonld:x", NOW);
  // A fallback rank on the plain row; the person saved the long one, which an agent ranked.
  await sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by) values
            (${USER}::uuid, ${b.id}, 0.3, 'Music in Valencia.', 'fallback'),
            (${USER}::uuid, ${a.id}, 0.9, 'You love her.', 'agent:run')`;
  await sql`update sawk.feed set state = 'saved' where event_id = ${a.id}`;
  await sql`insert into sawk.feedback (user_id, event_id, action) values (${USER}::uuid, ${a.id}, 'save')`;

  assertEquals(await collapseDuplicates(sql, NOW), 1);
  const rows = await sql`select id, title, all_day, price_min, seen from sawk.events order by title`;
  assertEquals(rows.map((r) => r.title), ["Candlelight: Queen & ABBA", "Francisca Valenzuela"]);
  const kept = rows[1];
  assertEquals([kept.id, kept.all_day, Number(kept.price_min)], [b.id, false, 22]);
  assertEquals((kept.seen as { via: string }[]).map((s) => s.via).sort(), ["jsonld:ae", "jsonld:sk"]);
  const feed = await sql`select event_id, state, score, reason, ranked_by from sawk.feed`;
  assertEquals(feed.map((f) => [f.event_id, f.state, Number(f.score).toFixed(1), f.reason, f.ranked_by]), [
    [b.id, "saved", "0.9", "You love her.", "agent:run"],
  ]);
  assertEquals((await sql`select event_id from sawk.feedback`).map((f) => f.event_id), [b.id]);
  // Nothing left to do; the next sighting of the long title lands on the kept row.
  assertEquals(await collapseDuplicates(sql, NOW), 0);
  assertEquals(await upsertEvents(sql, [a], "jsonld:ae", NOW), { added: 0, updated: 1, skipped: 0 });
  assertEquals((await sql`select count(*)::int as n from sawk.events`)[0].n, 2);
  await close();
});

Deno.test("collapse: a duplicate only on one side moves its feed row; past and cancelled rows are left alone", async () => {
  const { sql, close } = await testDb();
  const USER = "22222222-2222-4222-8222-222222222222";
  const a = await allevents(), b = await songkick();
  for (const e of [a, b]) {
    const m = mergeEvent(null, e, "jsonld:" + e.url, NOW);
    await sql`insert into sawk.events (id, title, starts_at, all_day, tz, city, venue, category, url, seen)
              values (${e.id}, ${m.title}, ${m.startsAt}::timestamptz, ${m.allDay}, ${m.tz}, ${m.city}, ${m.venue}, ${m.category},
                      ${m.url}, ${sql.json(m.seen)}::jsonb)`;
  }
  await sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by) values (${USER}::uuid, ${a.id}, 0.4, 'r', 'fallback')`;
  // Long over: not touched, even though it is a pair.
  await sql`insert into sawk.events (id, title, starts_at, city, venue, category, url) values
            ('old1', 'Morat', '2026-09-01T19:00:00Z', 'Valencia', 'Roig Arena', 'music', 'https://x.test/1'),
            ('old2', 'Morat Valencia Tickets', '2026-09-01T19:00:00Z', 'Valencia', 'Roig Arena', 'music', 'https://x.test/2')`;
  assertEquals(await collapseDuplicates(sql, NOW), 1);
  assertEquals((await sql`select event_id from sawk.feed`).map((f) => f.event_id), [b.id]);
  assertEquals((await sql`select count(*)::int as n from sawk.events where id in ('old1', 'old2')`)[0].n, 2);
  await close();
});

Deno.test("collapse: a festival and its workshops stay apart whatever the order; the stronger state and end time survive", async () => {
  const { sql, close } = await testDb();
  const USER = "33333333-3333-4333-8333-333333333333";
  const put = (id: string, title: string, startsAt: string, allDay: boolean, endsAt: string | null = null) =>
    sql`insert into sawk.events (id, title, starts_at, ends_at, all_day, tz, city, venue, category, url, first_seen_at)
        values (${id}, ${title}, ${startsAt}::timestamptz, ${endsAt}::timestamptz, ${allDay}, 'Europe/Madrid', 'Valencia',
                'UPV', 'other', ${"https://x.test/" + id}, ${NOW.toISOString()}::timestamptz)`;
  // "a…" sorts first: the umbrella is processed before both workshops.
  await put("a-umbrella", "Digital Jove 2026", "2026-11-04T23:00:00Z", true);
  await put("b-pixel", "Digital Jove 2026 - Pixel Art", "2026-11-04T23:00:00Z", true);
  await put("c-xr", "Digital Jove 2026 - Showroom XR", "2026-11-04T23:00:00Z", true);
  // Two timed rows of one talk: the kept one has no end, the other knows it.
  await put("d-talk", "AI Night", "2026-11-04T18:00:00Z", false);
  await put("e-talk", "AI Night Valencia Tickets", "2026-11-04T18:00:00Z", false, "2026-11-04T20:00:00Z");
  await sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by, state) values
            (${USER}::uuid, 'd-talk', 0.5, 'r', 'fallback', 'saved'),
            (${USER}::uuid, 'e-talk', 0.5, 'r', 'fallback', 'going')`;
  assertEquals(await collapseDuplicates(sql, NOW), 1);
  assertEquals((await sql`select id from sawk.events order by id`).map((r) => r.id), [
    "a-umbrella",
    "b-pixel",
    "c-xr",
    "d-talk",
  ]);
  const [talk] = await sql`select ends_at from sawk.events where id = 'd-talk'`;
  assertEquals(new Date(talk.ends_at as string).toISOString(), "2026-11-04T20:00:00.000Z");
  assertEquals((await sql`select state from sawk.feed where user_id = ${USER}::uuid`).map((r) => r.state), ["going"]);
  await close();
});
