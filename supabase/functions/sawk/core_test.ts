import { assert, assertEquals } from "jsr:@std/assert@1";
import * as core from "./core.ts";
import { addEvents } from "./events.ts";
import { ev, inHours, setup, USER_A, USER_B, ymd } from "./testkit.ts";
import { AppError } from "./util.ts";

type S = Awaited<ReturnType<typeof setup>>;

async function seed(s: S, user = USER_A, events: Record<string, unknown>[] = [ev("A"), ev("B"), ev("C")]) {
  const { runId } = await core.runStart(s.ctx(user), { agent: "claude-code", model: "test" });
  const added = await addEvents(s.ctx(user), { runId, events });
  return { runId, ids: added.ids };
}
const err = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  assert(e instanceof AppError, "expected an AppError, got " + e);
  return e;
};

// MARK: - runs

Deno.test("runs: start, finish, list; a run is private", async () => {
  const s = await setup();
  const { runId } = await core.runStart(s.ctx(), { agent: "codex", cities: ["Valencia"] });
  const fin = await core.runFinish(s.ctx(), { runId, status: "partial", notes: "Madrid skipped" });
  assertEquals([fin.status, fin.notes, fin.cities], ["partial", "Madrid skipped", ["Valencia"]]);
  assert(fin.finishedAt);
  assertEquals((await core.listRuns(s.ctx(), {})).runs.length, 1);
  assertEquals((await core.listRuns(s.ctx(USER_B), {})).runs.length, 0);
  assertEquals((await err(core.runFinish(s.ctx(USER_B), { runId, status: "ok" }))).status, 404);
  assertEquals((await err(core.runFinish(s.ctx(), { runId, status: "great" }))).status, 400);
  assertEquals((await err(core.runStart(s.ctx(), {}))).status, 400);
  await s.close();
});

// MARK: - rank

Deno.test("rank: clamps, truncates, rejects unknown ids, counts on the run", async () => {
  const s = await setup();
  const { runId, ids } = await seed(s);
  const r = await core.rank(s.ctx(), {
    runId,
    items: [
      { eventId: ids[0], score: 1.7, reason: "x".repeat(500) },
      { eventId: ids[1], score: -3, reason: "low" },
      { eventId: "ev_unknown", score: 0.5, reason: "?" },
      { eventId: ids[2], score: "nope", reason: "?" },
    ],
  });
  assertEquals(r.ranked, 2);
  assertEquals((r as { rejected: Array<{ index: number }> }).rejected.map((x) => x.index), [2, 3]);
  const rows = await s
    .sql`select event_id, score, reason, ranked_by from sawk.feed where user_id = ${USER_A}::uuid order by score desc`;
  assertEquals(rows.map((x) => Number(x.score)), [1, 0]);
  assertEquals((rows[0].reason as string).length, 280);
  assertEquals(rows[0].ranked_by, `agent:${runId}`);
  assertEquals((await s.sql`select ranked from sawk.runs where id = ${runId}::uuid`)[0].ranked, 2);
  await s.close();
});

Deno.test("rank: a new rank replaces score and reason but keeps the person's state and rating", async () => {
  const s = await setup();
  const { runId, ids } = await seed(s);
  await core.rank(s.ctx(), { runId, items: [{ eventId: ids[0], score: 0.4, reason: "first" }] });
  await core.feedback(s.ctx(), { eventId: ids[0], action: "going" });
  await core.feedback(s.ctx(), { eventId: ids[0], action: "rate", rating: 2 });
  await core.feedback(s.ctx(), { eventId: ids[1], action: "hide" });
  const run2 = (await core.runStart(s.ctx(), { agent: "grok" })).runId;
  await core.rank(s.ctx(), {
    runId: run2,
    items: [{ eventId: ids[0], score: 0.95, reason: "second" }, { eventId: ids[1], score: 0.8, reason: "again" }],
  });
  const f = await core.feed(s.ctx(), { state: "went" });
  assertEquals(f.items.length, 1);
  const it = f.items[0];
  assertEquals([it.score, it.reason, it.rankedBy, it.state, it.rating], [0.95, "second", `agent:${run2}`, "went", 2]);
  const hidden = await core.feed(s.ctx(), { state: "hidden" });
  assertEquals(hidden.items[0].reason, "again");
  assertEquals(hidden.items[0].state, "hidden", "re-ranking a hidden event does not bring it back");
  await s.close();
});

Deno.test("rank: only your own run; another person's feed is untouched", async () => {
  const s = await setup();
  const a = await seed(s, USER_A);
  const b = (await core.runStart(s.ctx(USER_B), { agent: "codex" })).runId;
  assertEquals(
    (await err(core.rank(s.ctx(USER_B), { runId: a.runId, items: [{ eventId: a.ids[0], score: 1, reason: "x" }] })))
      .status,
    404,
  );
  // B may rank A's event (events are shared), into B's own feed only.
  await core.rank(s.ctx(USER_B), { runId: b, items: [{ eventId: a.ids[0], score: 0.2, reason: "meh" }] });
  assertEquals((await core.feed(s.ctx(USER_A), {})).items.length, 0);
  assertEquals((await core.feed(s.ctx(USER_B), {})).items.length, 1);
  await s.close();
});

// MARK: - feedback

Deno.test("feedback: the state machine", async () => {
  const s = await setup();
  const { runId, ids } = await seed(s);
  await core.rank(s.ctx(), { runId, items: ids.map((eventId) => ({ eventId, score: 0.5, reason: "r" })) });
  const act = async (eventId: string, action: string, rating?: number) =>
    await core.feedback(s.ctx(), { eventId, action, ...(rating !== undefined ? { rating } : {}) });
  const [e1, e2] = ids;

  assertEquals((await act(e1, "save")).state, "saved");
  assertEquals((await act(e1, "unsave")).state, "new");
  assertEquals((await act(e1, "going")).state, "going");
  assertEquals((await act(e1, "hide")).state, "hidden");
  assertEquals((await act(e1, "skip")).state, "skipped");
  assertEquals((await act(e1, "went")).state, "went");

  // rate: sets the rating; new, saved and going become went; hidden and skipped stay.
  for (
    const [before, after] of [["new", "went"], ["save", "went"], ["going", "went"], ["hide", "hidden"], [
      "skip",
      "skipped",
    ]] as const
  ) {
    await s.sql`delete from sawk.feed where user_id = ${USER_A}::uuid and event_id = ${e2}`;
    await s
      .sql`insert into sawk.feed (user_id, event_id, score, reason, ranked_by) values (${USER_A}::uuid, ${e2}, 0.5, 'r', 'x')`;
    if (before !== "new") await act(e2, before);
    const r = await act(e2, "rate", -1);
    assertEquals([r.state, r.rating], [after, -1], `rate after ${before}`);
  }
  const everyone = await s.sql`select action, rating, via from sawk.feedback where event_id = ${e1} order by id`;
  assertEquals(everyone.map((x) => x.action), ["save", "unsave", "going", "hide", "skip", "went"]);
  assertEquals(everyone[0].via, "web");

  assertEquals((await err(act(e1, "rate"))).status, 400, "rate needs a rating");
  assertEquals((await err(act(e1, "rate", 3))).status, 400);
  assertEquals((await err(act(e1, "dance"))).status, 400);
  assertEquals((await err(act("ev_missing", "save"))).status, 404);
  await s.close();
});

Deno.test("feedback: an event nobody ranked gets a row with the default score; via and note are recorded", async () => {
  const s = await setup();
  const { ids } = await seed(s);
  const r = await core.feedback(s.ctx(USER_A, { client: "mcp:claude" }), {
    eventId: ids[0],
    action: "save",
    note: "from a friend",
  });
  assertEquals([r.state, r.score, r.reason, r.rankedBy], ["saved", 0.5, "You added this yourself.", "person"]);
  const fb = (await s.sql`select via, note from sawk.feedback`)[0];
  assertEquals([fb.via, fb.note], ["mcp:claude", "from a friend"]);
  await s.close();
});

// MARK: - feed

Deno.test("feed: filters (hidden, cancelled, past, range, city, state), order and limit", async () => {
  const s = await setup();
  const events = [
    ev("Tonight early", { startsAt: inHours(3), tz: "Europe/Madrid" }),
    ev("Tomorrow low", { startsAt: inHours(26) }),
    ev("Tomorrow high", { startsAt: inHours(27) }),
    ev("Hidden one", { startsAt: inHours(28) }),
    ev("Cancelled one", { startsAt: inHours(29) }),
    ev("Just started", { startsAt: inHours(-2) }),
    ev("Long over", { startsAt: inHours(-5) }),
    ev("Ended already", { startsAt: inHours(-5), endsAt: inHours(-4) }),
    ev("Still on", { startsAt: inHours(-5), endsAt: inHours(2) }),
    ev("Next month", { startsAt: inHours(24 * 30) }),
    ev("Madrid thing", { city: "Madrid", startsAt: inHours(30) }),
  ];
  const { runId, ids } = await seed(s, USER_A, events);
  const byTitle = Object.fromEntries(events.map((e, i) => [e.title as string, ids[i]]));
  const score = (t: string) =>
    ({ Tomorrow: 0, "Tomorrow low": 0.2, "Tomorrow high": 0.9 } as Record<string, number>)[t] ?? 0.5;
  await core.rank(s.ctx(), {
    runId,
    items: events.map((e) => ({ eventId: byTitle[e.title as string], score: score(e.title as string), reason: "r" })),
  });
  await core.feedback(s.ctx(), { eventId: byTitle["Hidden one"], action: "hide" });
  await s.sql`update sawk.events set cancelled = true where id = ${byTitle["Cancelled one"]}`;
  // The events past starts_at: the 5-hour-old ones were accepted by add_events (limit is 6 h) but are past for the feed.

  const titles = async (a: Record<string, unknown> = {}) =>
    (await core.feed(s.ctx(), a)).items.map((i) => i.event.title);
  const def = await titles({ from: ymd(-1) }); // "today" is Madrid's: start from yesterday so the hour of the day does not matter
  assert(def.includes("Tonight early") && def.includes("Just started") && def.includes("Still on"));
  assert(!def.includes("Hidden one"), "hidden is excluded");
  assert(!def.includes("Cancelled one"), "cancelled is excluded");
  assert(!def.includes("Long over") && !def.includes("Ended already"), "past is excluded");
  assert(!def.includes("Next month"), "default range is 14 days");
  assert(def.indexOf("Tomorrow high") < def.indexOf("Tomorrow low"), "within a day, best score first");
  assert(
    def.indexOf("Tonight early") < def.indexOf("Tomorrow high") ||
      def.indexOf("Just started") < def.indexOf("Tomorrow high"),
    "days in order",
  );

  assertEquals(await titles({ state: "hidden" }), ["Hidden one"]);
  assertEquals(await titles({ city: "MADRID" }), ["Madrid thing"]);
  assertEquals((await titles({ limit: 2 })).length, 2);
  assert((await titles({ from: ymd(25), to: ymd(40) })).includes("Next month"));
  const dflt = await core.feed(s.ctx(), {});
  assertEquals(
    (Date.parse(dflt.to) - Date.parse(dflt.from)) / 86_400_000,
    14,
    "default range: today through 14 days on",
  );
  assertEquals((await err(core.feed(s.ctx(), { from: "2026-13-40" }))).status, 400);
  assertEquals((await err(core.feed(s.ctx(), { from: ymd(5), to: ymd(1) }))).status, 400);
  assertEquals((await core.feed(s.ctx(USER_B), { from: ymd(-1) })).items.length, 0, "another person sees nothing");
  await s.close();
});

Deno.test("feed: the item has the FeedItem shape", async () => {
  const s = await setup();
  const { runId, ids } = await seed(s, USER_A, [ev("Shape", { priceMin: 10, tags: ["x"], description: "d" })]);
  await core.rank(s.ctx(), { runId, items: [{ eventId: ids[0], score: 0.7, reason: "because" }] });
  const it = (await core.feed(s.ctx(), {})).items[0];
  assertEquals(Object.keys(it).sort(), ["event", "rankedAt", "rankedBy", "rating", "reason", "score", "state"]);
  assertEquals(it.event.id, ids[0]);
  assertEquals([
    it.event.priceMin,
    it.event.tags,
    it.event.description,
    it.event.cancelled,
    it.event.startsAt.endsWith("Z"),
  ], [10, ["x"], "d", false, true]);
  await s.close();
});

// MARK: - profile

Deno.test("profile: defaults, partial update, validation, clearing", async () => {
  const s = await setup();
  const p0 = await core.profile(s.ctx(), {});
  assertEquals([p0.homeCity, p0.langs, p0.maxPerDay, p0.currency], [null, ["en"], 3, "EUR"]);
  const p1 = await core.profile(s.ctx(), {
    set: {
      homeCity: "Valencia",
      homeCountry: "es",
      homeTz: "Europe/Madrid",
      likes: ["jazz", "Jazz", "natural wine"],
      priceMax: 25,
    },
  });
  assertEquals([p1.homeCity, p1.homeCountry, p1.likes, p1.priceMax], ["Valencia", "ES", ["jazz", "natural wine"], 25]);
  const p2 = await core.profile(s.ctx(), { set: { avoids: ["techno"], maxPerDay: 5 } });
  assertEquals(
    [p2.homeCity, p2.likes, p2.avoids, p2.maxPerDay],
    ["Valencia", ["jazz", "natural wine"], ["techno"], 5],
    "untouched fields stay",
  );
  const p3 = await core.profile(s.ctx(), { set: { priceMax: null, notes: "I like small rooms." } });
  assertEquals([p3.priceMax, p3.notes], [null, "I like small rooms."]);
  assertEquals((await core.profile(s.ctx(USER_B), {})).homeCity, null, "another person's profile is theirs");

  const bad = (set: Record<string, unknown>) => err(core.profile(s.ctx(), { set }));
  assertEquals((await bad({ homeTz: "Mars/Base" })).status, 400);
  assertEquals((await bad({ maxPerDay: 0 })).status, 400);
  assertEquals((await bad({ maxPerDay: 11 })).status, 400);
  assertEquals((await bad({ likes: Array.from({ length: 31 }, (_, i) => "t" + i) })).status, 400);
  assertEquals((await bad({ likes: ["x".repeat(41)] })).status, 400);
  assertEquals((await bad({ notes: "n".repeat(2001) })).status, 400);
  assertEquals((await bad({ langs: "en" })).status, 400);
  assertEquals((await bad({ homeCountry: "Spain" })).status, 400);
  assertEquals((await bad({ colour: "red" })).status, 400);
  assertEquals((await core.profile(s.ctx(), {})).maxPerDay, 5, "a failed update changes nothing");
  assertEquals(
    (await core.profile(s.ctx(), { set: { likes: Array.from({ length: 30 }, (_, i) => "t" + i) } })).likes.length,
    30,
  );
  await s.close();
});

// MARK: - windows and sources

Deno.test("windows: add (idempotent), list, delete; private to the person", async () => {
  const s = await setup();
  const w = await core.addWindow(s.ctx(), {
    city: "Lisbon",
    country: "pt",
    from: ymd(5),
    to: ymd(9),
    note: "conference",
  });
  assertEquals([w.city, w.country, w.from, w.to], ["Lisbon", "PT", ymd(5), ymd(9)]);
  assertEquals((await core.addWindow(s.ctx(), { city: "lisbon", from: ymd(5), to: ymd(9) })).id, w.id);
  assertEquals((await core.listWindows(s.ctx())).windows.length, 1);
  assertEquals((await core.listWindows(s.ctx(USER_B))).windows.length, 0);
  assertEquals((await err(core.deleteWindow(s.ctx(USER_B), w.id))).status, 404);
  assertEquals((await err(core.addWindow(s.ctx(), { city: "X", from: ymd(9), to: ymd(5) }))).status, 400);
  assertEquals((await err(core.addWindow(s.ctx(), { city: "X", from: ymd(1), to: ymd(500) }))).status, 400);
  assertEquals(
    (await err(core.addWindow(s.ctx(), { city: "X", from: ymd(1), to: ymd(2), tz: "Nope/Nope" }))).status,
    400,
  );
  await core.deleteWindow(s.ctx(), w.id);
  assertEquals((await core.listWindows(s.ctx())).windows.length, 0);
  await s.close();
});

Deno.test("sources: add, dedupe by kind and url, public addresses only", async () => {
  const s = await setup();
  const a = await core.addSource(s.ctx(), {
    city: "Valencia",
    country: "ES",
    kind: "ics",
    url: "https://venue.example/cal.ics",
    label: "Venue",
    categories: ["music", "bogus"],
  });
  assertEquals([a.kind, a.categories, a.active], ["ics", ["music"], true]);
  const again = await core.addSource(s.ctx(USER_B), {
    city: "Valencia",
    kind: "ics",
    url: "https://venue.example/cal.ics",
    label: "Other label",
  });
  assertEquals([again.id, again.label], [a.id, "Venue"], "a known source comes back as it is");
  for (
    const url of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://[::1]/x",
      "http://intranet/x",
      "file:///etc/passwd",
      "http://db.internal/x",
    ]
  ) {
    assertEquals((await err(core.addSource(s.ctx(), { city: "V", kind: "web", url, label: "x" }))).status, 400, url);
  }
  assertEquals(
    (await err(core.addSource(s.ctx(), { city: "V", kind: "carrier-pigeon", url: "https://x.example", label: "x" })))
      .status,
    400,
  );
  await s.close();
});

// MARK: - context

Deno.test("context: home window covers the range, tz decides today, lists are compact", async () => {
  const s = await setup();
  await core.profile(s.ctx(), {
    set: { homeCity: "Valencia", homeCountry: "ES", homeTz: "Europe/Madrid", likes: ["jazz"] },
  });
  const c = await core.context(s.ctx(), { days: 10 }) as any;
  assertEquals(c.windows.length, 1);
  assertEquals(c.windows[0].source, "home");
  assertEquals([c.windows[0].city, c.windows[0].from, c.windows[0].to], ["Valencia", c.today, c.windows[0].to]);
  const days = Math.round((Date.parse(c.windows[0].to) - Date.parse(c.windows[0].from)) / 86_400_000);
  assertEquals(days, 10);
  assertEquals(c.profile.likes, ["jazz"]);
  assertEquals(c.history, { counts: {}, recent: [] });
  assertEquals(c.pool, { Valencia: 0 });
  assert(!JSON.stringify(c).includes("null"), "nulls are omitted");
  assertEquals((await err(core.context(s.ctx(), { days: 0 }))).status, 400);
  assertEquals((await err(core.context(s.ctx(), { days: 61 }))).status, 400);
  await s.close();
});

Deno.test("context: a manual trip splits home into before and after; sources and pool follow the cities", async () => {
  const s = await setup();
  await core.profile(s.ctx(), { set: { homeCity: "Valencia", homeCountry: "ES", homeTz: "Europe/Madrid" } });
  await core.addWindow(s.ctx(), {
    city: "Lisbon",
    country: "PT",
    tz: "Europe/Lisbon",
    from: ymd(4),
    to: ymd(6),
    note: "work",
  });
  await core.addSource(s.ctx(), { city: "valencia", kind: "ics", url: "https://v.example/c.ics", label: "V cal" });
  await core.addSource(s.ctx(), { city: "Lisbon", kind: "web", url: "https://l.example/agenda", label: "L agenda" });
  await core.addSource(s.ctx(), { city: "Paris", kind: "web", url: "https://p.example/agenda", label: "P agenda" });
  await seed(s, USER_A, [
    ev("Home gig", { startsAt: inHours(24) }),
    ev("Lisbon gig", { city: "Lisbon", tz: "Europe/Lisbon", startsAt: inHours(24 * 5) }),
    ev("Paris gig", { city: "Paris" }),
  ]);

  const c = await core.context(s.ctx(), { days: 14 }) as any;
  const w = c.windows.map((x: any) => `${x.source}:${x.city}:${x.from}..${x.to}`);
  assertEquals(w.length, 3);
  assertEquals(w[0], `home:Valencia:${c.today}..${ymd(3)}`);
  assertEquals(w[1], `manual:Lisbon:${ymd(4)}..${ymd(6)}`);
  assertEquals(w[2].startsWith(`home:Valencia:${ymd(7)}..`), true);
  assert(c.windows[1].id, "a manual window carries its id");
  assertEquals(c.windows[1].note, "work");
  assertEquals(
    c.sources.map((x: any) => x.label),
    ["L agenda", "V cal"],
    "sources for window cities only, case-insensitive",
  );
  assertEquals(c.pool.Lisbon, 1);
  assertEquals(c.pool.Valencia, 1);
  assert(!("Paris" in c.pool));
  await s.close();
});

Deno.test("context: Loco's stays come in as source loco, clipped; Loco home is the fallback home", async () => {
  const s = await setup();
  await s.exec(`
    create or replace function sawk.loco_home(p_user uuid) returns table (city text, country text, tz text)
      language sql as $$ select 'Valencia'::text, 'ES'::text, 'Europe/Madrid'::text $$;
    create or replace function sawk.loco_windows(p_user uuid, p_from date, p_to date)
      returns table (city text, country text, tz text, starts_on date, ends_on date, trip text)
      language sql as $$ select 'Rome'::text, 'IT'::text, 'Europe/Rome'::text, (current_date - 2), (current_date + 3), 'Roma 2026'::text $$;
    create or replace function sawk.loco_busy(p_user uuid, p_from date, p_to date)
      returns table (day date, title text, starts_at timestamptz, ends_at timestamptz, city text, kind text)
      language sql as $$ select current_date + 1, 'Dinner with Ana'::text, now(), null::timestamptz, 'Rome'::text, 'event'::text $$;
    create or replace function sawk.loco_taste(p_user uuid) returns jsonb
      language sql as $$ select '{"reviews": 4, "likes": ["jazz"], "avoids": [], "byCategory": {}}'::jsonb $$;`);
  const c = await core.context(s.ctx(), { days: 10 }) as any;
  assertEquals(c.windows.map((w: any) => [w.source, w.city, w.from === c.today, w.to]), [
    ["loco", "Rome", true, c.windows[0].to],
    ["home", "Valencia", false, c.windows[1].to],
  ]);
  assertEquals(c.windows[0].note, "Roma 2026");
  assertEquals(c.windows[0].from, c.today, "a stay that began before today is clipped to today");
  assertEquals(c.windows[1].tz, "Europe/Madrid");
  assertEquals(c.busy[0].title, "Dinner with Ana");
  assertEquals(c.taste.reviews, 4);
  await s.close();
});

Deno.test("context: no home city says how to set it; history and last runs are the caller's own", async () => {
  const s = await setup();
  const none = await core.context(s.ctx(), {}) as any;
  assertEquals(none.windows, []);
  assert(none.hints[0].includes("sawk_profile"));

  await core.profile(s.ctx(), { set: { homeCity: "Valencia", homeTz: "Europe/Madrid" } });
  const { runId, ids } = await seed(s, USER_A, [ev("Jazz"), ev("Techno", { category: "nightlife" })]);
  await core.rank(s.ctx(), { runId, items: ids.map((eventId) => ({ eventId, score: 0.5, reason: "r" })) });
  await core.feedback(s.ctx(), { eventId: ids[0], action: "save" });
  await core.feedback(s.ctx(), { eventId: ids[0], action: "going" });
  await core.feedback(s.ctx(), { eventId: ids[1], action: "hide" });
  await core.feedback(s.ctx(), { eventId: ids[1], action: "unsave" });
  // An old reaction falls out of the 90-day window.
  await core.feedback(s.ctx(), { eventId: ids[1], action: "skip" });
  await s.sql`update sawk.feedback set at = now() - interval '100 days' where action = 'skip'`;

  const c = await core.context(s.ctx(), {}) as any;
  assertEquals(c.history.counts, { music: { save: 1, going: 1 }, nightlife: { hide: 1, unsave: 1 } });
  assertEquals(c.history.recent.map((r: any) => r.action), ["hide", "going", "save"], "newest first, unsave left out");
  assertEquals(c.history.recent[0].title, "Techno");
  assertEquals(c.lastRuns.length, 1);
  assertEquals(c.lastRuns[0].agent, "claude-code");

  const b = await core.context(s.ctx(USER_B), {}) as any;
  assertEquals(b.history, { counts: {}, recent: [] });
  assertEquals(b.lastRuns, []);
  await s.close();
});
