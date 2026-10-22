import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FN, ISS, jwt, legacyKey, setup, USER_A, USER_B } from "./testkit.ts";
import { newTokenText, sha256Hex } from "./auth.ts";

Deno.test("missing and malformed tokens are 401 with a WWW-Authenticate pointing at the metadata", async () => {
  const s = await setup();
  const meta = `Bearer resource_metadata="${FN}/.well-known/oauth-protected-resource"`;
  for (const path of ["/mcp", "/api/profile", "/api/feed"]) {
    const r = await s.http(path === "/mcp" ? "POST" : "GET", path, path === "/mcp" ? { body: {} } : {});
    assertEquals(r.status, 401, path);
    assertEquals(r.headers.get("www-authenticate"), meta);
    assertEquals(r.json.error, "unauthorized");
  }
  const bad = await s.http("GET", "/api/profile", { bearer: "not-a-token" });
  assertEquals(bad.status, 401);
  assertStringIncludes(bad.headers.get("www-authenticate")!, 'error="invalid_token"');
  await s.close();
});

Deno.test("the anon and service-role keys, and an HS256 forgery, never verify", async () => {
  const s = await setup();
  for (const role of ["anon", "service_role", "authenticated"]) {
    assertEquals((await s.http("GET", "/api/profile", { bearer: await legacyKey(role) })).status, 401, role);
  }
  await s.close();
});

Deno.test("a JWT with the wrong role, issuer, key or expiry is rejected; a good one is accepted", async () => {
  const s = await setup();
  const bad: Array<[string, string]> = [
    ["role", await jwt(USER_A, { role: "anon" })],
    ["issuer", await jwt(USER_A, {}, { iss: "https://evil.example/auth/v1" })],
    ["key", await jwt(USER_A, {}, { other: true })],
    ["expired", await jwt(USER_A, {}, { expIn: -3600 })],
  ];
  for (const [why, t] of bad) assertEquals((await s.http("GET", "/api/profile", { bearer: t })).status, 401, why);
  assertEquals((await s.http("GET", "/api/profile", { bearer: await jwt() })).status, 200);
  await s.close();
});

Deno.test("a failed login is logged by reason, never with the token", async () => {
  const s = await setup();
  const t = await jwt(USER_A, {}, { iss: "https://evil.example/auth/v1" });
  await s.http("GET", "/api/profile", { bearer: t });
  assertEquals(s.lines[0].ev, "auth");
  assert(!JSON.stringify(s.lines).includes(t));
  await s.close();
});

Deno.test("a PAT works; a revoked, unknown or malformed one does not", async () => {
  const s = await setup();
  const { token, id } = await s.pat();
  const ok = await s.http("GET", "/api/profile", { bearer: token });
  assertEquals(ok.status, 200);

  await s.sql`update sawk.tokens set revoked_at = now() where id = ${id}::uuid`;
  assertEquals((await s.http("GET", "/api/profile", { bearer: token })).status, 401);

  assertEquals((await s.http("GET", "/api/profile", { bearer: newTokenText() })).status, 401); // never stored
  assertEquals((await s.http("GET", "/api/profile", { bearer: "sawk_pat_short" })).status, 401);
  await s.close();
});

Deno.test("a PAT's last_used_at is touched at most once a minute", async () => {
  const s = await setup();
  const { token, id } = await s.pat();
  const used = async () =>
    (await s.sql<{ t: Date | null }>`select last_used_at as t from sawk.tokens where id = ${id}::uuid`)[0].t;
  assertEquals(await used(), null);
  await s.http("GET", "/api/profile", { bearer: token });
  const first = await used();
  assert(first);
  await s.http("GET", "/api/profile", { bearer: token });
  assertEquals((await used())!.getTime(), first!.getTime(), "second call inside a minute does not rewrite");
  await s.sql`update sawk.tokens set last_used_at = now() - interval '2 minutes' where id = ${id}::uuid`;
  await s.http("GET", "/api/profile", { bearer: token });
  assert(Date.now() - (await used())!.getTime() < 30_000, "a stale last_used_at is refreshed");
  await s.close();
});

Deno.test("token text is sawk_pat_ plus 32 base62 characters, stored only as a hash", async () => {
  const s = await setup();
  const t = newTokenText();
  assert(/^sawk_pat_[0-9A-Za-z]{32}$/.test(t));
  assert(newTokenText() !== t);
  const created = await s.http("POST", "/api/tokens", { bearer: await jwt(), body: { name: "laptop" } });
  assertEquals(created.status, 200);
  const plain = created.json.token as string;
  assert(/^sawk_pat_[0-9A-Za-z]{32}$/.test(plain));
  assertEquals(created.json.prefix, plain.slice(0, 12));
  const row = (await s.sql<{ hash: string }>`select hash from sawk.tokens where id = ${created.json.id}::uuid`)[0];
  assertEquals(row.hash, await sha256Hex(plain));
  assert(!JSON.stringify(await s.sql`select * from sawk.tokens`).includes(plain));
  // The listing never carries the hash or the plaintext.
  const list = await s.http("GET", "/api/tokens", { bearer: await jwt() });
  assert(!JSON.stringify(list.json).includes(plain) && !JSON.stringify(list.json).includes(row.hash));
  await s.close();
});

Deno.test("a PAT cannot create, list or revoke tokens; neither can an OAuth agent token; a session can", async () => {
  const s = await setup();
  const { token } = await s.pat();
  const oauth = await jwt(USER_A, { client_id: "claude-connector" });
  for (const bearer of [token, oauth]) {
    assertEquals((await s.http("POST", "/api/tokens", { bearer, body: { name: "x" } })).status, 403);
    assertEquals((await s.http("GET", "/api/tokens", { bearer })).status, 403);
  }
  const made = await s.http("POST", "/api/tokens", { bearer: await jwt(), body: { name: "ok" } });
  assertEquals(made.status, 200);
  assertEquals((await s.http("DELETE", `/api/tokens/${made.json.id}`, { bearer: token })).status, 403);
  assertEquals((await s.http("DELETE", `/api/tokens/${made.json.id}`, { bearer: await jwt() })).status, 200);
  // Revoked: the new token no longer authenticates.
  assertEquals((await s.http("GET", "/api/profile", { bearer: made.json.token })).status, 401);
  await s.close();
});

Deno.test("a person cannot see or revoke another person's tokens", async () => {
  const s = await setup();
  const a = await s.http("POST", "/api/tokens", { bearer: await jwt(USER_A), body: { name: "a" } });
  const listB = await s.http("GET", "/api/tokens", { bearer: await jwt(USER_B) });
  assertEquals(listB.json.tokens, []);
  assertEquals((await s.http("DELETE", `/api/tokens/${a.json.id}`, { bearer: await jwt(USER_B) })).status, 404);
  assertEquals((await s.http("GET", "/api/profile", { bearer: a.json.token })).status, 200);
  await s.close();
});

Deno.test("the via of a caller: session, OAuth client and PAT", async () => {
  const s = await setup();
  const { authenticate } = await import("./auth.ts");
  const cfg = { supabaseUrl: "https://example-project.supabase.co", sql: () => s.sql, keys: s.deps.keys };
  const req = (t: string) => new Request(FN, { headers: { authorization: `Bearer ${t}` } });
  assertEquals((await authenticate(req(await jwt()), cfg)).via, "jwt");
  assertEquals((await authenticate(req(await jwt(USER_A, { client_id: "abc" })), cfg)).via, "oauth:abc");
  const { token, id } = await s.pat();
  assertEquals(await authenticate(req(token), cfg), { userId: USER_A, via: `pat:${id}` });
  assertEquals(ISS, "https://example-project.supabase.co/auth/v1");
  await s.close();
});

Deno.test("protected-resource metadata, health and CORS", async () => {
  const s = await setup();
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const r = await s.http("GET", p);
    assertEquals(r.status, 200);
    assertEquals(r.json, { resource: `${FN}/mcp`, authorization_servers: [ISS], bearer_methods_supported: ["header"] });
  }
  const h = await s.http("GET", "/api/health");
  assertEquals(h.status, 200);
  assertEquals(h.json.ok, true);

  const pre = await s.http("OPTIONS", "/api/feed", { headers: { origin: "https://zaitsew.github.io" } });
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("access-control-allow-origin"), "https://zaitsew.github.io");
  assertStringIncludes(pre.headers.get("access-control-allow-headers")!, "x-sawk-client");
  const local = await s.http("GET", "/api/feed", { headers: { origin: "http://localhost:5173" } });
  assertEquals(local.headers.get("access-control-allow-origin"), "http://localhost:5173"); // even a 401 carries CORS
  const evil = await s.http("OPTIONS", "/api/feed", { headers: { origin: "https://evil.example" } });
  assertEquals(evil.headers.get("access-control-allow-origin"), null);
  assertEquals((await s.http("OPTIONS", "/mcp")).headers.get("access-control-allow-origin"), "*");
  assertEquals((await s.http("GET", "/nope", { bearer: await jwt() })).status, 404);
  assertEquals((await s.http("GET", "/mcp", { bearer: await jwt() })).status, 405);
  await s.close();
});
