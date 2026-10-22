import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { checkUrl, guardedFetch, isPrivateIp, MAX_REDIRECTS } from "./ssrf.ts";
import { hostAllowed } from "./hosts.ts";

Deno.test("private, loopback, link-local and reserved addresses are recognised", () => {
  for (
    const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "2001:db8::1",
    ]
  ) assert(isPrivateIp(ip), ip);
  for (
    const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]
  ) {
    assert(!isPrivateIp(ip), ip);
  }
});

Deno.test("URLs: scheme, credentials, internal names and IP literals", async () => {
  const blocked = [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "http://user:pw@example.com/",
    "http://localhost/x",
    "http://db.internal/",
    "http://intranet/",
    "http://127.0.0.1:54321/",
    "http://[::1]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://printer.local/",
  ];
  for (const u of blocked) assert(await checkUrl(u), u);
  assertEquals(await checkUrl("https://example.com/feed.ics"), null);
  assertEquals(await checkUrl("http://93.184.216.34/x"), null);
});

Deno.test("a public name that resolves to a private address is refused; a resolver that fails is not trusted", async () => {
  assertEquals(
    await checkUrl("https://evil.example/x", () => Promise.resolve(["10.0.0.5"])),
    "evil.example resolves to a private address",
  );
  assertEquals(
    await checkUrl("https://evil.example/x", () => Promise.resolve(["93.184.216.34", "127.0.0.1"])),
    "evil.example resolves to a private address",
  );
  assertEquals(await checkUrl("https://ok.example/x", () => Promise.resolve(["93.184.216.34", "2606:4700::1"])), null);
  const r = await checkUrl("https://ok.example/x", () => Promise.reject(new Error("no permission")));
  assertEquals(r, "cannot verify ok.example: no permission");
});

Deno.test("redirects are followed by hand and every hop is checked", async () => {
  const seen: string[] = [];
  const inner = ((url: string, init: RequestInit) => {
    seen.push(url);
    assertEquals(init.redirect, "manual");
    if (url === "https://a.example/start") {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "/next" } }));
    }
    if (url === "https://a.example/next") return Promise.resolve(new Response("done", { status: 200 }));
    if (url === "https://a.example/evil") {
      return Promise.resolve(
        new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest" } }),
      );
    }
    return Promise.resolve(new Response("?", { status: 404 }));
  }) as unknown as typeof fetch;
  const f = guardedFetch(inner, () => Promise.resolve(["93.184.216.34"]));
  assertEquals(await (await f("https://a.example/start")).text(), "done");
  assertEquals(seen, ["https://a.example/start", "https://a.example/next"]);
  seen.length = 0;
  await assertRejects(() => f("https://a.example/evil"), Error, "private address");
  assertEquals(seen, ["https://a.example/evil"]); // the second hop was never fetched
});

Deno.test("a redirect loop ends", async () => {
  const inner =
    ((url: string) =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: url } }))) as unknown as typeof fetch;
  const f = guardedFetch(inner, () => Promise.resolve(["93.184.216.34"]));
  await assertRejects(() => f("https://a.example/loop"), Error, `more than ${MAX_REDIRECTS}`);
});

Deno.test("allow-list: a host that is not listed is refused before it is resolved, and so is a redirect to one", async () => {
  const seen: string[] = [];
  const resolved: string[] = [];
  const inner = ((url: string) => {
    seen.push(url);
    if (url === "https://www.meetup.com/g/events/ical/") {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/feed.ics" } }),
      );
    }
    return Promise.resolve(new Response("ok"));
  }) as unknown as typeof fetch;
  const f = guardedFetch(inner, (h) => (resolved.push(h), Promise.resolve(["93.184.216.34"])), (h) => hostAllowed(h));
  await assertRejects(() => f("https://other.example/feed.ics"), Error, "not on the ingest allow-list");
  assertEquals([seen, resolved], [[], []]); // not fetched, not even resolved
  assertEquals(await (await f("https://www.eventbrite.es/d/x/")).text(), "ok");
  // A listed host that redirects off the list is stopped at the second hop.
  await assertRejects(() => f("https://www.meetup.com/g/events/ical/"), Error, "elsewhere.example");
  assertEquals(seen.includes("https://elsewhere.example/feed.ics"), false);
});
