// Migrations 0003 (the seeded sources) and 0004 (the daily call) on an in-memory Postgres.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { CATEGORIES } from "../_shared/types.ts";
import { hostAllowed, hostOf } from "../_shared/ingest/hosts.ts";
import { checkUrl } from "../_shared/ingest/ssrf.ts";
import { parseTmQuery } from "../_shared/ingest/ticketmaster.ts";
import { testDb } from "../_shared/testdb.ts";

const SEED = new URL("../../../db/migrations/0003_sources_seed.sql", import.meta.url);

Deno.test("seed: Valencia sources by kind, all public https pages, valid categories", async () => {
  const { sql, close } = await testDb();
  const kinds = Object.fromEntries(
    (await sql`select kind, count(*)::int as n from sawk.sources group by kind`).map((r) => [r.kind, r.n]),
  );
  assertEquals(kinds, { ics: 8, jsonld: 17, ticketmaster: 1, web: 9 });
  const rows = await sql`select kind, url, label, categories, city, country, active, added_by from sawk.sources`;
  for (const r of rows) {
    assertEquals([r.city, r.country, r.active, r.added_by], ["Valencia", "ES", true, null]);
    assert((r.label as string).length > 0);
    for (const c of r.categories as string[]) assert((CATEGORIES as readonly string[]).includes(c), `${r.url}: ${c}`);
    if (r.kind === "ticketmaster") {
      assertEquals(parseTmQuery(r.url as string).get("city"), "Valencia");
    } else {
      assert((r.url as string).startsWith("https://"), r.url as string);
      assertEquals(await checkUrl(r.url as string), null);
      // Every seeded source the ingest reads is on its allow-list; `web` rows are for agents and need not be.
      if (r.kind !== "web") assert(hostAllowed(hostOf(r.url as string)!), `not on the allow-list: ${r.url}`);
    }
  }
  await close();
});

Deno.test("seed: running it again adds nothing and keeps what a person changed", async () => {
  const { sql, close, exec } = await testDb();
  await sql`update sawk.sources set active = false where kind = 'web' and url like '%valenciabasket%'`;
  await exec(await Deno.readTextFile(SEED));
  assertEquals((await sql`select count(*)::int as n from sawk.sources`)[0].n, 35);
  assertEquals((await sql`select active from sawk.sources where url like '%valenciabasket%'`)[0].active, false);
  await close();
});

Deno.test("cron: the kick function exists, is closed to the public, and says what is missing without Vault", async () => {
  const { sql, close } = await testDb();
  assertEquals(
    (await sql`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'sawk' and p.proname = 'ingest_kick'`)[0].n,
    1,
  );
  assertEquals((await sql`select has_function_privilege('anon', 'sawk.ingest_kick()', 'execute') as ok`)[0].ok, false);
  assertEquals(
    (await sql`select has_function_privilege('authenticated', 'sawk.ingest_kick()', 'execute') as ok`)[0].ok,
    false,
  );
  await assertRejects(() => sql`select sawk.ingest_kick()`, Error, "Vault is not available");
  assertEquals(
    (await sql`select count(*)::int as n from information_schema.tables where table_schema = 'sawk'`)[0].n,
    11,
  );
  await close();
});
