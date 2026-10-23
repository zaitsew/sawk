import { assert, assertEquals } from "jsr:@std/assert@1";
import { testDb } from "./testdb.ts";
import {
  assignDay,
  BASE,
  dayPlaces,
  emptyHistory,
  matchStrength,
  type ScoreEvent,
  scoreEvent,
  type ScoreProfile,
  writeFallbackRanks,
} from "./score.ts";

const NOW = new Date("2026-10-23T10:00:00Z");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const ev = (over: Partial<ScoreEvent> = {}): ScoreEvent => ({
  title: "Quiet evening",
  category: "other",
  tags: [],
  venue: null,
  city: "Valencia",
  startsAt: "2026-10-24T18:00:00Z",
  endsAt: null,
  allDay: false,
  priceMin: null,
  priceMax: null,
  currency: null,
  isFree: null,
  ...over,
});
const profile = (over: Partial<ScoreProfile> = {}): ScoreProfile => ({
  likes: [],
  avoids: [],
  priceMax: null,
  currency: "EUR",
  ...over,
});
const day = "2026-10-24";

Deno.test("matching: whole phrase, all words, plurals, too short", () => {
  const words = ["tech", "meetup", "at", "las", "naves"];
  assertEquals(matchStrength("tech meetups", words), 1);
  assertEquals(matchStrength("meetup tech", words), 0.8);
  assertEquals(matchStrength("jazz", words), 0);
  assertEquals(matchStrength("ai", ["ai", "talk"]), 0); // under three letters
});

Deno.test("score: no signal is the base; a like lifts it and names itself", () => {
  const plain = scoreEvent(ev(), profile(), emptyHistory(), [], day);
  assertEquals(plain.score, BASE);
  assertEquals(plain.reason, "Other in Valencia.");
  const liked = scoreEvent(
    ev({ title: "Jazz Trio", category: "music", isFree: true }),
    profile({ likes: ["jazz"] }),
    emptyHistory(),
    [],
    day,
  );
  assert(liked.score > 0.6);
  assertEquals(liked.reason, "Matches 'jazz', and it's free.");
});

Deno.test("score: avoided topics sink; price over the limit costs; free helps", () => {
  const avoided = scoreEvent(
    ev({ title: "Techno marathon", category: "nightlife" }),
    profile({ likes: ["techno"], avoids: ["techno"] }),
    emptyHistory(),
    [],
    day,
  );
  assert(avoided.score <= 0.15);
  assertEquals(avoided.reason, "Avoided: 'techno'.");
  const dear = scoreEvent(ev({ priceMin: 60, currency: "EUR" }), profile({ priceMax: 30 }), emptyHistory(), [], day);
  assert(dear.score < BASE);
  assertEquals(dear.reason, "Over your 30 EUR limit.");
  const otherCurrency = scoreEvent(
    ev({ priceMin: 60, currency: "USD" }),
    profile({ priceMax: 30 }),
    emptyHistory(),
    [],
    day,
  );
  assertEquals(otherCurrency.score, BASE); // not comparable, not penalised
  assertEquals(scoreEvent(ev({ isFree: true }), profile(), emptyHistory(), [], day).reason, "Free to attend.");
});

Deno.test("score: history by category and venue; a busy day, and a clash", () => {
  const h = emptyHistory();
  h.byCategory.set("music", { saved: 2, went: 1, neg: 0 });
  const up = scoreEvent(ev({ category: "music" }), profile(), h, [], day);
  assertEquals(up.reason, "You've saved 3 music events.");
  assert(up.score > BASE);
  const h2 = emptyHistory();
  h2.byVenue.set("blue room", { saved: 0, went: 0, neg: 1 });
  const down = scoreEvent(ev({ venue: "Blue Room" }), profile(), h2, [], day);
  assertEquals(down.reason, "You hid events at Blue Room.");
  const busy = [{ day, startsAt: "2026-10-24T17:00:00Z", endsAt: "2026-10-24T19:00:00Z" }];
  assertEquals(scoreEvent(ev(), profile(), emptyHistory(), busy, day).reason, "You have something on at that time.");
  const later = [{ day, startsAt: "2026-10-24T08:00:00Z", endsAt: "2026-10-24T09:00:00Z" }];
  assertEquals(scoreEvent(ev(), profile(), emptyHistory(), later, day).reason, "You already have plans that day.");
});

Deno.test("windows: home, overridden by trips; the day an event belongs to", () => {
  const home = { city: "Valencia", country: "ES", tz: "Europe/Madrid" };
  const places = dayPlaces(
    home,
    [{ city: "Madrid", country: "ES", tz: null, from: "2026-10-26", to: "2026-10-27" }],
    "2026-10-24",
    5,
  );
  assertEquals([...places.values()].map((p) => p.city), ["Valencia", "Valencia", "Madrid", "Madrid", "Valencia"]);
  const madrid = { ...ev({ city: "Madrid", startsAt: "2026-10-26T18:00:00Z" }), tz: "Europe/Madrid" };
  assertEquals(assignDay(madrid, places, NOW), "2026-10-26");
  const valencia = { ...ev({ startsAt: "2026-10-26T18:00:00Z" }), tz: "Europe/Madrid" };
  assertEquals(assignDay(valencia, places, NOW), null); // the person is in Madrid that day
  const over = { ...ev({ startsAt: "2026-10-22T18:00:00Z" }), tz: "Europe/Madrid" };
  assertEquals(assignDay(over, places, NOW), null);
});

async function seed(sql: Awaited<ReturnType<typeof testDb>>["sql"]) {
  await sql`insert into sawk.profiles (user_id, home_city, home_country, home_tz, likes, avoids, max_per_day)
            values (${USER}::uuid, 'Valencia', 'ES', 'Europe/Madrid', ${sql.array(["jazz"])}::text[], ${
    sql.array(["techno"])
  }::text[], 1)`;
  const mk = (id: string, title: string, start: string, over: Record<string, unknown> = {}) =>
    sql`insert into sawk.events (id, title, starts_at, city, tz, category, url, is_free, cancelled)
        values (${id}, ${title}, ${start}::timestamptz, ${(over.city as string) ?? "Valencia"}, 'Europe/Madrid',
                ${(over.category as string) ?? "other"}, 'https://x.test/' || ${id}, ${
      (over.free as boolean) ?? null
    }::boolean, ${(over.cancelled as boolean) ?? false})`;
  await mk("e1", "Jazz Trio", "2026-10-24T18:00:00Z", { category: "music" });
  await mk("e2", "Plain talk", "2026-10-24T17:00:00Z");
  await mk("e3", "Techno night", "2026-10-24T21:00:00Z", { category: "nightlife" });
  await mk("e4", "Another plain", "2026-10-24T16:00:00Z");
  await mk("e5", "Madrid jazz", "2026-10-24T18:00:00Z", { city: "Madrid", category: "music" });
  await mk("e6", "Far away", "2026-12-24T18:00:00Z");
  await mk("e7", "Cancelled jazz", "2026-10-25T18:00:00Z", { category: "music", cancelled: true });
  await mk("e8", "Yesterday", "2026-10-22T10:00:00Z");
}

Deno.test("fallback rank: top N per day, only in the person's city and horizon, best first", async () => {
  const { sql, close } = await testDb();
  await seed(sql);
  const r = await writeFallbackRanks(sql, NOW);
  assertEquals([r.users, r.errors], [1, []]);
  // max_per_day 1 -> keep 3 of e1, e2, e3, e4 on the 24th
  const rows =
    await sql`select event_id, score, reason, ranked_by, state from sawk.feed where user_id = ${USER}::uuid order by score desc, event_id`;
  assertEquals(rows.map((x) => x.event_id), ["e1", "e2", "e4"]);
  assert(rows.every((x) => x.ranked_by === "fallback" && x.state === "new"));
  assertEquals(rows[0].reason, "Matches 'jazz'.");
  assertEquals(r.ranked, 3);
  await close();
});

Deno.test("fallback rank: never overwrites an agent's rank, state or rating; refreshes its own", async () => {
  const { sql, close } = await testDb();
  await seed(sql);
  await sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by, state, rating)
            values (${USER}::uuid, 'e1', 0.99, 'Agent says yes', 'agent:run-1', 'saved', null)`;
  await sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by, state)
            values (${USER}::uuid, 'e2', 0.01, 'stale', 'fallback', 'saved')`;
  await writeFallbackRanks(sql, NOW);
  const [agent] =
    await sql`select score, reason, ranked_by, state from sawk.feed where event_id = 'e1' and user_id = ${USER}::uuid`;
  assertEquals([Number(agent.score), agent.reason, agent.ranked_by, agent.state], [
    0.99,
    "Agent says yes",
    "agent:run-1",
    "saved",
  ]);
  const [mine] =
    await sql`select score, reason, ranked_by, state from sawk.feed where event_id = 'e2' and user_id = ${USER}::uuid`;
  assertEquals(mine.state, "saved"); // the person's state survives a re-rank
  assertEquals(mine.ranked_by, "fallback");
  assert(Number(mine.score) > 0.01);
  await close();
});

Deno.test("fallback rank: prunes untouched fallback rows that fall out, keeps acted-on ones; cancelled go", async () => {
  const { sql, close } = await testDb();
  await seed(sql);
  await writeFallbackRanks(sql, NOW);
  // e3 (techno, avoided) was never in the top 3. Plant rows for it and for the cancelled one.
  await sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by) values (${USER}::uuid, 'e3', 0.5, 'old', 'fallback')`;
  await sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by) values (${USER}::uuid, 'e7', 0.5, 'old', 'fallback')`;
  await sql`update sawk.feed set state = 'going' where event_id = 'e4' and user_id = ${USER}::uuid`;
  const r = await writeFallbackRanks(sql, NOW);
  assertEquals(r.pruned >= 2, true);
  const ids = (await sql`select event_id from sawk.feed where user_id = ${USER}::uuid order by event_id`).map((x) =>
    x.event_id
  );
  assertEquals(ids, ["e1", "e2", "e4"]);
  await close();
});

Deno.test("fallback rank: a trip window moves the person; history and other people's rows are separate", async () => {
  const { sql, close } = await testDb();
  await seed(sql);
  await sql`insert into sawk.windows (user_id, city, country, tz, starts_on, ends_on)
            values (${USER}::uuid, 'Madrid', 'ES', 'Europe/Madrid', '2026-10-24', '2026-10-24')`;
  await sql`insert into sawk.profiles (user_id, home_city, home_country, home_tz) values (${OTHER}::uuid, 'Valencia', 'ES', 'Europe/Madrid')`;
  await sql`insert into sawk.feedback (user_id, event_id, action) values (${OTHER}::uuid, 'e2', 'hide')`;
  const r = await writeFallbackRanks(sql, NOW);
  assertEquals(r.users, 2);
  const mine = (await sql`select event_id from sawk.feed where user_id = ${USER}::uuid order by event_id`).map((x) =>
    x.event_id
  );
  assertEquals(mine, ["e5"]); // on the 24th she is in Madrid: only the Madrid event
  const theirs = await sql`select event_id, score from sawk.feed where user_id = ${OTHER}::uuid order by score desc`;
  assert(theirs.length > 0 && !theirs.some((x) => x.event_id === "e5"));
  const hidden = theirs.find((x) => x.event_id === "e2");
  assert(hidden && Number(hidden.score) < 0.3); // hiding one "other" event counts against the whole category
  await close();
});

Deno.test("fallback rank: a trip window written in another language matches the city's events", async () => {
  const { sql, close, exec } = await testDb();
  await seed(sql);
  await exec(`
    create or replace function sawk.loco_windows(p_user uuid, p_from date, p_to date)
      returns table (city text, country text, tz text, starts_on date, ends_on date, trip text)
      language sql as $$ select 'Мадрид'::text, 'ES'::text, 'Europe/Madrid'::text, '2026-10-24'::date, '2026-10-24'::date, 't'::text $$;`);
  await writeFallbackRanks(sql, NOW);
  const mine = (await sql`select event_id from sawk.feed where user_id = ${USER}::uuid order by event_id`).map((x) =>
    x.event_id
  );
  assertEquals(mine, ["e5"]); // "Мадрид" is Madrid: the Madrid event, not the Valencia ones
  await close();
});

Deno.test("windows: a city key beats the written name", () => {
  const home = { city: "Валенсия", country: "ES", tz: "Europe/Madrid", key: "valencia" };
  const places = dayPlaces(home, [], "2026-10-24", 2);
  const valencia = { ...ev({ startsAt: "2026-10-24T18:00:00Z" }), tz: "Europe/Madrid", cityKey: "valencia" };
  assertEquals(assignDay(valencia, places, NOW), "2026-10-24");
  assertEquals(assignDay({ ...valencia, cityKey: "madrid" }, places, NOW), null);
  // No key on one side: the names are compared, as before.
  assertEquals(assignDay({ ...valencia, cityKey: null }, places, NOW), null);
});

Deno.test("fallback rank: a profile with no home city is skipped, not an error", async () => {
  const { sql, close } = await testDb();
  await sql`insert into sawk.profiles (user_id) values (${OTHER}::uuid)`;
  assertEquals(await writeFallbackRanks(sql, NOW), { users: 0, ranked: 0, pruned: 0, errors: [] });
  await close();
});
