import { assert, assertEquals } from "jsr:@std/assert@1";
import { testDb } from "../testdb.ts";
import { finalizeEvents, type ReadyEvent } from "./normalize.ts";
import type { Sql } from "../db.ts";
import { type Merged, mergeEvent, upsertEvents } from "./upsert.ts";
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
