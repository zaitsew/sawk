import { assert, assertEquals } from "jsr:@std/assert@1";
import { isAllowed, parseRobots, robotsAllows } from "./robots.ts";
import { fakeFetch, fixture } from "./testing.ts";

Deno.test("rules for * apply; wildcards, $ and Allow by longest match", async () => {
  const rules = parseRobots(await fixture("robots.txt"));
  assertEquals(isAllowed(rules, "/events/"), true);
  assertEquals(isAllowed(rules, "/private/area"), false);
  assertEquals(isAllowed(rules, "/private/public-page"), true); // the longer Allow wins
  assertEquals(isAllowed(rules, "/find/?location=es--Valencia"), false);
  assertEquals(isAllowed(rules, "/find/"), true);
  assertEquals(isAllowed(rules, "/search"), false);
  assertEquals(isAllowed(rules, "/search/more"), true); // "$" anchors
});

Deno.test("a group for our own token replaces *", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: SAWk\nDisallow: /nope\n");
  assertEquals(isAllowed(rules, "/anything"), true);
  assertEquals(isAllowed(rules, "/nope/x"), false);
});

Deno.test("an empty Disallow allows everything; no file means allowed; an error means blocked", async () => {
  assertEquals(isAllowed(parseRobots("User-agent: *\nDisallow:\n"), "/x"), true);
  const missing = fakeFetch({ "https://a.test/robots.txt": { status: 404 } });
  assert((await robotsAllows(missing, "https://a.test/page", new Map())).ok);
  const down = fakeFetch({ "https://a.test/robots.txt": { status: 503 } });
  const r = await robotsAllows(down, "https://a.test/page", new Map());
  assertEquals(r, { ok: false, error: "robots.txt of a.test is unreachable" });
});
