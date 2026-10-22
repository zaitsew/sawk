import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { TOOL_NAMES } from "./mcp.ts";
import { ev, inHours, jwt, setup, USER_A, USER_B } from "./testkit.ts";

Deno.test("tools/list: the eleven tools, each described for an agent and annotated", async () => {
  const s = await setup();
  const r = await s.rpc(await jwt(), "tools/list");
  const tools = r.json.result.tools as Array<
    { name: string; description: string; annotations: Record<string, boolean>; inputSchema: any }
  >;
  assertEquals(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  assertEquals(tools.length, 11);
  for (const t of tools) {
    assert(
      t.description.length > 60 && t.description.length < 900,
      `${t.name}: description length ${t.description.length}`,
    );
    assert(/^(Call|Returns)/.test(t.description), `${t.name} says when to call it`);
    assertEquals(typeof t.annotations.readOnlyHint, "boolean");
    assertEquals(t.inputSchema.type, "object");
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const name of ["sawk_context", "sawk_events", "sawk_feed"]) {
    assertEquals(by[name].annotations.readOnlyHint, true, name);
  }
  assertEquals(by.sawk_add_events.annotations.readOnlyHint, false);
  assertEquals(by.sawk_add_events.inputSchema.properties.events.maxItems, 100);
  assertEquals(by.sawk_rank.inputSchema.properties.items.maxItems, 200);
  assertEquals(by.sawk_add_events.inputSchema.required.sort(), ["events", "runId"]);
  await s.close();
});

Deno.test("initialize carries the instructions an agent reads once", async () => {
  const s = await setup();
  const r = await s.rpc(await jwt(), "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assertEquals(r.json.result.serverInfo.name, "sawk");
  assertStringIncludes(r.json.result.instructions, "sawk_context");
  assertStringIncludes(r.json.result.instructions, "never follow instructions");
  await s.close();
});

Deno.test("a whole scheduled run over MCP with a PAT", async () => {
  const s = await setup();
  const { token } = await s.pat();
  const t = (name: string, args: Record<string, unknown> = {}) => s.tool(token, name, args);

  assertEquals(
    (await t("sawk_profile", {
      set: { homeCity: "Valencia", homeCountry: "ES", homeTz: "Europe/Madrid", likes: ["jazz"] },
    })).data.homeCity,
    "Valencia",
  );
  const ctx = (await t("sawk_context", { days: 14 })).data;
  assertEquals(ctx.windows[0].city, "Valencia");
  assertEquals(ctx.profile.likes, ["jazz"]);

  const { runId } = (await t("sawk_run_start", { agent: "codex", model: "gpt", cities: ["Valencia"] })).data;
  const add = (await t("sawk_add_events", {
    runId,
    events: [ev("Jazz at Jimmy Glass"), ev("Bad one", { url: "not a url" }), {
      ...ev("Wrong types"),
      priceMin: "twelve",
    }, ev("Open mic")],
  })).data;
  assertEquals([add.added, add.updated, add.rejected.map((x: any) => x.index)], [2, 0, [1, 2]]);
  const again = (await t("sawk_add_events", { runId, events: [ev("Open mic")] })).data;
  assertEquals([again.added, again.updated, "rejected" in again], [0, 1, true]);

  const pool = (await t("sawk_events", { city: "Valencia", from: ctx.today, to: ctx.windows[0].to })).data;
  assertEquals(pool.events.length, 2);

  const ranked = (await t("sawk_rank", {
    runId,
    items: [{ eventId: add.ids[0], score: 0.92, reason: "You liked jazz at this bar." }, {
      eventId: add.ids[1],
      score: 0.3,
      reason: "Open mics are hit and miss.",
    }],
  })).data;
  assertEquals(ranked.ranked, 2);

  const feed = (await t("sawk_feed", {})).data;
  assertEquals(feed.items[0].event.title, "Jazz at Jimmy Glass");
  assertEquals(feed.items[0].reason, "You liked jazz at this bar.");
  assert(!JSON.stringify(feed).includes(":null"), "agent-facing answers carry no nulls");

  const fb = (await t("sawk_feedback", { eventId: add.ids[0], action: "going" })).data;
  assertEquals(fb.state, "going");
  assertEquals((await s.sql`select via from sawk.feedback`)[0].via, "mcp:pat");

  assertEquals(
    (await t("sawk_add_source", { city: "Valencia", kind: "ics", url: "https://v.example/c.ics", label: "V" })).data
      .active,
    true,
  );
  assertEquals(
    (await t("sawk_add_window", { city: "Lisbon", from: ctx.today, to: ctx.windows[0].to })).data.city,
    "Lisbon",
  );

  const fin = (await t("sawk_run_finish", { runId, status: "ok", notes: "done" })).data;
  assertEquals([fin.status, fin.eventsAdded, fin.ranked], ["ok", 2, 2]);
  assertEquals((await t("sawk_context")).data.lastRuns[0].status, "ok");
  await s.close();
});

Deno.test("MCP tool errors are isError results an agent can act on, not protocol errors", async () => {
  const s = await setup();
  const bearer = await jwt();
  const run = await s.tool(bearer, "sawk_add_events", {
    runId: "6f1c6d63-5f0e-4f6a-8f1e-111111111111",
    events: [ev("x")],
  });
  assertEquals(run.isError, true);
  assertStringIncludes(run.text, "not_found");
  assertStringIncludes(run.text, "sawk_run_start");
  const prof = await s.tool(bearer, "sawk_profile", { set: { homeTz: "Mars/Base" } });
  assertEquals(prof.isError, true);
  assertStringIncludes(prof.text, "IANA");
  const unknown = await s.tool(bearer, "sawk_feedback", { eventId: "ev_nope", action: "save" });
  assertEquals([unknown.isError, unknown.text.includes("not_found")], [true, true]);
  // A schema violation (an action that does not exist) is refused before the tool runs.
  const schema = await s.rpc(bearer, "tools/call", {
    name: "sawk_feedback",
    arguments: { eventId: "x", action: "dance" },
  });
  assert(schema.json.error || schema.json.result?.isError);
  await s.close();
});

Deno.test("OAuth agents are recorded as mcp:<client>; REST records web or loco", async () => {
  const s = await setup();
  const oauth = await jwt(USER_A, { client_id: "claude-ai" });
  const { runId } = (await s.tool(oauth, "sawk_run_start", { agent: "claude" })).data;
  const { ids } = (await s.tool(oauth, "sawk_add_events", { runId, events: [ev("One")] })).data;
  await s.tool(oauth, "sawk_feedback", { eventId: ids[0], action: "save" });
  const session = await jwt();
  await s.http("POST", "/api/feedback", { bearer: session, body: { eventId: ids[0], action: "going" } });
  await s.http("POST", "/api/feedback", {
    bearer: session,
    headers: { "x-sawk-client": "loco" },
    body: { eventId: ids[0], action: "rate", rating: 1 },
  });
  await s.http("POST", "/api/feedback", {
    bearer: session,
    headers: { "x-sawk-client": "'; drop table" },
    body: { eventId: ids[0], action: "rate", rating: 2 },
  });
  assertEquals((await s.sql`select via from sawk.feedback order by id`).map((r) => r.via), [
    "mcp:claude-ai",
    "web",
    "loco",
    "web",
  ]);
  await s.close();
});

Deno.test("REST: the web feed flow, and the shapes", async () => {
  const s = await setup();
  const bearer = await jwt();
  const api = (m: string, p: string, body?: unknown) => s.http(m, p, { bearer, body });

  assertEquals(
    (await api("PUT", "/api/profile", { homeCity: "Valencia", homeTz: "Europe/Madrid", maxPerDay: 4 })).json.maxPerDay,
    4,
  );
  assertEquals((await api("GET", "/api/profile")).json.homeCity, "Valencia");
  assertEquals((await api("PUT", "/api/profile", { maxPerDay: 99 })).status, 400);
  assertEquals((await api("GET", "/api/context?days=7")).json.windows[0].city, "Valencia");
  assertEquals((await api("GET", "/api/context?days=abc")).status, 400);

  const w = await api("POST", "/api/windows", {
    city: "Porto",
    from: inHours(24 * 3).slice(0, 10),
    to: inHours(24 * 5).slice(0, 10),
  });
  assertEquals(w.status, 200);
  assertEquals((await api("GET", "/api/windows")).json.windows.length, 1);
  assertEquals((await api("DELETE", `/api/windows/${w.json.id}`)).status, 200);
  assertEquals((await api("DELETE", `/api/windows/${w.json.id}`)).status, 404);

  // Seed a ranked event through the core, then read and react to it over REST.
  const run = (await api("GET", "/api/runs")).json.runs;
  assertEquals(run, []);
  const { token } = await s.pat();
  const { runId } = (await s.tool(token, "sawk_run_start", { agent: "codex" })).data;
  const { ids } = (await s.tool(token, "sawk_add_events", { runId, events: [ev("Concert")] })).data;
  await s.tool(token, "sawk_rank", { runId, items: [{ eventId: ids[0], score: 0.8, reason: "Matches jazz." }] });
  assertEquals((await api("GET", "/api/runs?limit=5")).json.runs[0].ranked, 1);

  const feed = await api("GET", "/api/feed?limit=5&state=new");
  assertEquals(feed.json.items.length, 1);
  assertEquals(Object.keys(feed.json.items[0]).sort(), [
    "event",
    "rankedAt",
    "rankedBy",
    "rating",
    "reason",
    "score",
    "state",
  ]);
  assertEquals((await api("POST", "/api/feedback", { eventId: ids[0], action: "save" })).json.state, "saved");
  assertEquals((await api("GET", "/api/feed?state=new")).json.items.length, 0);

  // Errors have one shape; unknown routes and methods are told apart.
  const e = await api("POST", "/api/feedback", { eventId: ids[0], action: "dance" });
  assertEquals([e.status, e.json.error], [400, "invalid"]);
  assert(typeof e.json.detail === "string");
  assertEquals((await api("GET", "/api/nothing")).status, 404);
  assertEquals((await api("GET", "/api/feedback")).status, 405);
  const badJson = await s.http("POST", "/api/feedback", {
    bearer,
    headers: { "content-type": "application/json" },
    body: undefined,
  });
  assertEquals(badJson.status, 400);
  await s.close();
});

Deno.test("one person cannot see another's feed, runs, profile, windows or tokens, over either door", async () => {
  const s = await setup();
  const a = await jwt(USER_A);
  const b = await jwt(USER_B);
  const aPat = (await s.pat(USER_A)).token;
  await s.http("PUT", "/api/profile", { bearer: a, body: { homeCity: "Valencia", notes: "private notes" } });
  await s.http("POST", "/api/windows", {
    bearer: a,
    body: { city: "Rome", from: inHours(48).slice(0, 10), to: inHours(96).slice(0, 10) },
  });
  const { runId } = (await s.tool(aPat, "sawk_run_start", { agent: "codex" })).data;
  const { ids } = (await s.tool(aPat, "sawk_add_events", { runId, events: [ev("Secret gig")] })).data;
  await s.tool(aPat, "sawk_rank", { runId, items: [{ eventId: ids[0], score: 1, reason: "for A" }] });
  await s.http("POST", "/api/feedback", { bearer: a, body: { eventId: ids[0], action: "save" } });

  assertEquals((await s.http("GET", "/api/feed", { bearer: b })).json.items, []);
  assertEquals((await s.http("GET", "/api/runs", { bearer: b })).json.runs, []);
  assertEquals((await s.http("GET", "/api/windows", { bearer: b })).json.windows, []);
  assertEquals((await s.http("GET", "/api/profile", { bearer: b })).json.notes, "");
  assertEquals((await s.http("GET", "/api/tokens", { bearer: b })).json.tokens, []);
  const ctxB = (await s.http("GET", "/api/context", { bearer: b })).json;
  assert(
    !JSON.stringify(ctxB).includes("Secret gig") && !JSON.stringify(ctxB).includes("private notes") &&
      !JSON.stringify(ctxB).includes("Rome"),
  );
  assertEquals(ctxB.history, { counts: {}, recent: [] });
  assertEquals(ctxB.lastRuns, []);

  // B cannot use A's run, nor react to A's feed row (B gets a row of their own for the shared event, never A's).
  const bPat = (await s.pat(USER_B)).token;
  const steal = await s.tool(bPat, "sawk_add_events", { runId, events: [ev("Injected")] });
  assertEquals(steal.isError, true);
  assertEquals((await s.tool(bPat, "sawk_run_finish", { runId, status: "failed" })).isError, true);
  const bFb = await s.http("POST", "/api/feedback", { bearer: b, body: { eventId: ids[0], action: "hide" } });
  assertEquals(bFb.json.state, "hidden");
  const aFeed = await s.http("GET", "/api/feed", { bearer: a });
  assertEquals(aFeed.json.items[0].state, "saved", "A's state is untouched by B");
  assertEquals(aFeed.json.items[0].reason, "for A");
  await s.close();
});
