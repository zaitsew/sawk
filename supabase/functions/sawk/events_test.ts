import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { addEvents, listEvents, validateEvent } from "./events.ts";
import { runStart } from "./core.ts";
import { ev, inHours, setup, USER_A, USER_B, ymd } from "./testkit.ts";
import { AppError } from "./util.ts";

const start = async (s: Awaited<ReturnType<typeof setup>>, user = USER_A) =>
  (await runStart(s.ctx(user), { agent: "claude-code" })).runId;

Deno.test("validateEvent: the rules, one by one", () => {
  const now = new Date();
  const why = (e: unknown) => {
    try {
      validateEvent(e, now);
      return null;
    } catch (x) {
      assert(x instanceof AppError);
      return x.detail;
    }
  };
  assertEquals(why(ev("ok")), null);
  assert(why({ ...ev("x"), title: "" })!.includes("title"));
  assert(why({ ...ev("x"), city: undefined })!.includes("city"));
  assert(why({ ...ev("x"), url: undefined })!.includes("url"));
  assert(why({ ...ev("x"), url: "ftp://example.org/x" })!.includes("http"));
  assert(why({ ...ev("x"), url: "javascript:alert(1)" })!.includes("http"));
  assert(why({ ...ev("x"), startsAt: "2026-12-01T20:00:00" })!.includes("offset"), "no offset");
  assert(why({ ...ev("x"), startsAt: "2026-12-01" })!.includes("offset"), "date only");
  assert(why({ ...ev("x"), startsAt: "tomorrow evening" })!.includes("startsAt"));
  assert(why({ ...ev("x"), startsAt: inHours(-7) })!.includes("past"), "older than 6 h");
  assertEquals(why({ ...ev("x"), startsAt: inHours(-5) }), null, "5 h ago is still accepted");
  assert(why({ ...ev("x"), startsAt: inHours(401 * 24) })!.includes("400 days"));
  assertEquals(why({ ...ev("x"), startsAt: inHours(399 * 24) }), null);
  assert(why({ ...ev("x"), endsAt: inHours(10) })!.includes("endsAt"));
  assert(why({ ...ev("x"), tz: "Mars/Olympus" })!.includes("tz"));
  assert(why({ ...ev("x"), country: "Spain" })!.includes("country"));
  assert(why({ ...ev("x"), lat: 40 })!.includes("lat and lon"));
  assert(why({ ...ev("x"), lat: 95, lon: 0 })!.includes("lat"));
  assert(why({ ...ev("x"), priceMin: 20, priceMax: 10 })!.includes("priceMax"));
  assert(why("a string")!.includes("object"));

  const v = validateEvent(
    {
      ...ev("y"),
      description: "d".repeat(900),
      category: "Opera Night",
      tags: ["Jazz", "jazz", " LIVE ", ...Array.from({ length: 20 }, (_, i) => "t" + i)],
      country: "es",
      currency: "eur",
    },
    now,
  );
  assertEquals(v.description!.length, 600);
  assertEquals(v.category, "other", "unknown category becomes other");
  assertEquals(v.tags.length, 10);
  assertEquals(v.tags.slice(0, 2), ["jazz", "live"], "lowercased, deduplicated");
  assertEquals(v.country, "ES");
  assertEquals(v.currency, "EUR");
  assertEquals(validateEvent({ ...ev("z"), category: "MUSIC" }, now).category, "music");
});

Deno.test("add_events: adds, rejects bad events by index, keeps the rest, counts on the run", async () => {
  const s = await setup();
  const runId = await start(s);
  const r = await addEvents(s.ctx(), {
    runId,
    events: [ev("Jazz night"), { ...ev("Broken"), url: "nope" }, ev("Open mic"), {
      ...ev("Old"),
      startsAt: inHours(-48),
    }],
  });
  assertEquals(r.added, 2);
  assertEquals(r.updated, 0);
  assertEquals(r.ids.length, 2);
  assertEquals(r.rejected.map((x) => x.index), [1, 3]);
  assert(r.rejected[0].why.includes("url"));
  const run = (await s.sql`select events_added, events_seen from sawk.runs where id = ${runId}::uuid`)[0];
  assertEquals([run.events_added, run.events_seen], [2, 2]);
  const row = (await s.sql`select * from sawk.events where id = ${r.ids[0]}`)[0];
  assertEquals(row.city, "Valencia");
  assertEquals((row.seen as Array<{ via: string }>)[0].via, `agent:${runId}`);
  await s.close();
});

Deno.test("add_events: the same event again is an update; sightings dedupe by url; last_seen_at moves", async () => {
  const s = await setup();
  const runId = await start(s);
  const first = await addEvents(s.ctx(), { runId, events: [ev("Jazz night")] });
  const id = first.ids[0];
  await s.sql`update sawk.events set last_seen_at = now() - interval '2 days' where id = ${id}`;

  // Same event, same url: updated, still one sighting.
  const again = await addEvents(s.ctx(), { runId, events: [ev("Jazz night")] });
  assertEquals([again.added, again.updated, again.ids[0]], [0, 1, id]);
  let row = (await s.sql`select seen, last_seen_at from sawk.events where id = ${id}`)[0];
  assertEquals((row.seen as unknown[]).length, 1);
  assert(Date.now() - (row.last_seen_at as Date).getTime() < 60_000, "last_seen_at bumped");

  // Same event from another page (title case and accents differ): same id, a second sighting.
  const other = await addEvents(s.ctx(), {
    runId,
    events: [{ ...ev("JAZZ NIGHT!"), url: "https://other.example/jazz" }],
  });
  assertEquals([other.added, other.updated, other.ids[0]], [0, 1, id]);
  row = (await s.sql`select seen from sawk.events where id = ${id}`)[0];
  assertEquals((row.seen as Array<{ url: string }>).map((x) => x.url).sort(), [
    "https://example.org/e/Jazz%20night",
    "https://other.example/jazz",
  ]);
  assertEquals((await s.sql`select count(*)::int as n from sawk.events`)[0].n, 1);
  // Two copies in one batch: one added, one updated.
  const dup = await addEvents(s.ctx(), { runId, events: [ev("Twin"), ev("Twin")] });
  assertEquals([dup.added, dup.updated], [1, 1]);
  await s.close();
});

Deno.test("add_events: a later sighting fills gaps and never erases what is known", async () => {
  const s = await setup();
  const runId = await start(s);
  const poor = {
    ...ev("Concert"),
    venue: "Palau",
    description: "short",
    tags: ["live"],
    priceMin: null,
    imageUrl: null,
    category: "other",
  };
  const id = (await addEvents(s.ctx(), { runId, events: [poor] })).ids[0];
  const rich = {
    ...ev("Concert"),
    venue: "Palau",
    url: "https://b.example/c",
    description: "A much longer description of the concert.",
    tags: ["rock", "live"],
    priceMin: 12,
    priceMax: 20,
    currency: "EUR",
    imageUrl: "https://b.example/c.jpg",
    ticketUrl: "https://b.example/t",
    category: "music",
    address: "Carrer 1",
    endsAt: inHours(34),
    lat: 39.47,
    lon: -0.37,
    isFree: false,
  };
  await addEvents(s.ctx(), { runId, events: [rich] });
  let r = (await s.sql`select * from sawk.events where id = ${id}`)[0];
  assertEquals(r.description, rich.description, "longer description wins");
  assertEquals(r.category, "music", "other is replaced by a real category");
  assertEquals(r.tags, ["live", "rock"], "tags are merged");
  assertEquals(Number(r.price_min), 12);
  assertEquals(r.image_url, "https://b.example/c.jpg");
  assertEquals(r.address, "Carrer 1");
  assertEquals(r.is_free, false);
  assertEquals(r.url, "https://example.org/e/Concert", "provenance of the first sighting stays");

  // A poorer sighting changes nothing it should not.
  await addEvents(s.ctx(), {
    runId,
    events: [{
      ...ev("Concert"),
      venue: "Palau",
      url: "https://c.example/c",
      description: "x",
      priceMin: 99,
      category: "film",
    }],
  });
  r = (await s.sql`select * from sawk.events where id = ${id}`)[0];
  assertEquals([r.description, r.category, Number(r.price_min), r.tags], [rich.description, "music", 12, [
    "live",
    "rock",
  ]]);
  assertEquals((r.seen as unknown[]).length, 3);
  await s.close();
});

Deno.test("add_events: the run must be yours; limits; empty", async () => {
  const s = await setup();
  const mine = await start(s, USER_A);
  const theirs = await start(s, USER_B);
  const nope = await addEvents(s.ctx(USER_A), { runId: theirs, events: [ev("x")] }).catch((e) => e);
  assert(nope instanceof AppError && nope.status === 404);
  assertEquals((await s.sql`select count(*)::int as n from sawk.events`)[0].n, 0);
  const junk = await addEvents(s.ctx(), { runId: "not-a-uuid", events: [ev("x")] }).catch((e) => e);
  assert(junk instanceof AppError && junk.status === 400);
  const many = await addEvents(s.ctx(), { runId: mine, events: Array.from({ length: 101 }, (_, i) => ev("e" + i)) })
    .catch((e) => e);
  assert(many instanceof AppError && many.detail.includes("100"));
  const none = await addEvents(s.ctx(), { runId: mine, events: [] }).catch((e) => e);
  assert(none instanceof AppError);
  const allBad = await addEvents(s.ctx(), { runId: mine, events: [{ title: "only a title" }] });
  assertEquals([allBad.added, allBad.rejected.length], [0, 1]);
  await s.close();
});

Deno.test("events: the pool in a city and range, case-insensitive, with the caller's own score", async () => {
  const s = await setup();
  const runId = await start(s);
  const ids = (await addEvents(s.ctx(), {
    runId,
    events: [
      ev("In range"),
      ev("Other city", { city: "Madrid" }),
      ev("Far", { startsAt: inHours(24 * 20) }),
      ev("Film", { category: "film" }),
    ],
  })).ids;
  await s.sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by) values (${USER_A}::uuid, ${
    ids[0]
  }, 0.9, 'r', 'agent:x')`;
  await s.sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by) values (${USER_B}::uuid, ${
    ids[0]
  }, 0.1, 'r', 'agent:x')`;
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const r = await listEvents(s.ctx(), { city: "valencia", from: day(-1), to: day(5) });
  assertEquals(r.events.map((e) => e.title).sort(), ["Film", "In range"]);
  assertEquals(r.events.find((e) => e.title === "In range")!.score, 0.9, "only the caller's score");
  assertEquals(r.events.find((e) => e.title === "Film")!.score, undefined);
  assertEquals(
    (await listEvents(s.ctx(), { city: "Valencia", from: day(-1), to: day(5), category: "film" })).events.length,
    1,
  );
  assertEquals((await listEvents(s.ctx(), { city: "Valencia", from: day(-1), to: day(30) })).events.length, 3);
  assertEquals(
    (await listEvents(s.ctx(USER_B), { city: "Valencia", from: day(-1), to: day(5) })).events.find((e) =>
      e.title === "In range"
    )!.score,
    0.1,
  );
  assertNotEquals(ids[0], ids[1]);
  await s.close();
});

Deno.test("add_events: the id uses the written offset's day when tz is missing", async () => {
  const s = await setup();
  const runId = await start(s);
  const startsAt = `${ymd(3)}T00:30:00+02:00`; // 22:30 UTC the day before
  const a = await addEvents(s.ctx(), { runId, events: [ev("Late show", { startsAt, tz: undefined })] });
  const b = await addEvents(s.ctx(), { runId, events: [ev("Late show", { startsAt, tz: "Etc/GMT-2" })] });
  assertEquals([a.added, b.added, b.updated], [1, 0, 1]);
  assertEquals(a.ids, b.ids);
  await s.close();
});
