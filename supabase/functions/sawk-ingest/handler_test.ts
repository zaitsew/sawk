import { assertEquals } from "jsr:@std/assert@1";
import { testDb } from "../_shared/testdb.ts";
import { fakeFetch } from "../_shared/ingest/testing.ts";
import { makeHandler, safeEqual } from "./handler.ts";

const SECRET = "test-secret-not-real";
const post = (h: (r: Request) => Promise<Response>, path = "", headers: Record<string, string> = {}) =>
  h(new Request(`http://localhost/sawk-ingest${path}`, { method: "POST", headers }));

Deno.test("safeEqual: equal, different, different length, empty", async () => {
  assertEquals(await safeEqual("abc", "abc"), true);
  assertEquals(await safeEqual("abc", "abd"), false);
  assertEquals(await safeEqual("abc", "abcd"), false);
  assertEquals(await safeEqual("", "x"), false);
});

Deno.test("handler: POST only, a secret must be set, the header must match", async () => {
  const { sql, close } = await testDb();
  const h = makeHandler({ sql, secret: SECRET, options: { fetch: fakeFetch({}), politeDelayMs: 0 } });
  const get = await h(
    new Request("http://localhost/sawk-ingest", { method: "GET", headers: { "x-sawk-cron": SECRET } }),
  );
  assertEquals([get.status, get.headers.get("allow")], [405, "POST"]);
  assertEquals((await post(h)).status, 401);
  assertEquals((await post(h, "", { "x-sawk-cron": "wrong" })).status, 401);
  assertEquals((await post(h, "", { authorization: `Bearer ${SECRET}` })).status, 401); // only the cron header counts
  const unset = makeHandler({ sql, secret: "", options: { fetch: fakeFetch({}) } });
  Deno.env.delete("SAWK_CRON_SECRET");
  assertEquals((await post(unset, "", { "x-sawk-cron": "" })).status, 503);
  assertEquals((await sql`select count(*)::int as n from sawk.runs`)[0].n, 0); // nothing ran
  await close();
});

Deno.test("handler: runs, answers with the summary; a bad or unknown source id is 400 / 404", async () => {
  const { sql, close } = await testDb();
  const [s] =
    await sql`insert into sawk.sources (city, country, kind, url, label) values ('Valencia', 'ES', 'ics', 'https://c.test/f.ics', 'C') returning id`;
  const ics =
    "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nDTSTART:20261201T190000Z\nSUMMARY:Winter concert\nURL:https://c.test/e\nEND:VEVENT\nEND:VCALENDAR";
  const f = fakeFetch({ "https://c.test/f.ics": { body: ics, type: "text/calendar" } });
  const h = makeHandler({
    sql,
    secret: SECRET,
    options: { fetch: f, politeDelayMs: 0, now: new Date("2026-10-23T10:00:00Z") },
  });
  const auth = { "x-sawk-cron": SECRET };

  assertEquals((await post(h, "?source=nope", auth)).status, 400);
  assertEquals((await post(h, "?source=99999999-9999-4999-8999-999999999999", auth)).status, 404);

  const res = await post(h, `?source=${s.id}`, auth);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.status, body.eventsAdded, body.sources.length], ["ok", 1, 1]);
  assertEquals((await sql`select agent from sawk.runs`)[0].agent, "ingest");

  const all = await post(h, "", auth);
  assertEquals((await all.json()).eventsAdded, 0); // nothing new the second time
  await close();
});

Deno.test("handler: a database failure is a 500 that does not echo the secret", async () => {
  const { sql, close } = await testDb();
  await close();
  const h = makeHandler({ sql, secret: SECRET, options: { fetch: fakeFetch({}) } });
  const res = await post(h, "", { "x-sawk-cron": SECRET });
  assertEquals(res.status, 500);
  assertEquals((await res.text()).includes(SECRET), false);
});
