// City keys (db/migrations/0005_city_keys.sql) on PGlite: one key per city in any spelling.
import { assertEquals } from "jsr:@std/assert@1";
import { testDb } from "./testdb.ts";

const LPGC = "las palmas de gran canaria";

Deno.test("city_key: case, accents, punctuation and other languages fold to one key", async () => {
  const { sql, close } = await testDb();
  const key = async (name: string | null) => (await sql`select sawk.city_key(${name}::text) as k`)[0].k;
  for (const name of ["Valencia", "VALENCIA", " valencia ", "València", "Валенсия"]) {
    assertEquals(await key(name), "valencia", name);
  }
  for (const name of ["Гран-Канария", "Gran Canaria", "Las Palmas", "Las Palmas de Gran Canaria", "Лас-Пальмас"]) {
    assertEquals(await key(name), LPGC, name);
  }
  assertEquals(await key("Барселона"), "barcelona");
  assertEquals(await key("Шанхай"), "shanghai");
  assertEquals(await key("München"), "munich");
  assertEquals(await key("Castellón de la Plana"), "castellon de la plana", "an unknown city is its folded name");
  assertEquals(await key(""), null);
  assertEquals(await key(null), null);
  assertEquals(
    (await sql`select sawk.city_name(sawk.city_key('Гран-Канария')) as n`)[0].n,
    "Las Palmas de Gran Canaria",
  );
  assertEquals((await sql`select sawk.city_name('mislata') as n`)[0].n, null);
  await close();
});

Deno.test("city_key: every seeded alias points at a seeded city, and every name is its own key", async () => {
  const { sql, close } = await testDb();
  const orphans =
    await sql`select alias from sawk.city_aliases a where not exists (select 1 from sawk.cities c where c.key = a.key)`;
  assertEquals(orphans, []);
  const off = await sql`select name from sawk.cities where sawk.city_key(name) <> key`;
  assertEquals(off, []);
  await close();
});

Deno.test("events and sources carry the key; a new alias re-keys the rows it moves", async () => {
  const { sql, close } = await testDb();
  await sql`delete from sawk.sources`;
  await sql`insert into sawk.events (id, title, starts_at, city, category, url)
            values ('e1', 'Gig', now() + interval '1 day', 'Валенсия', 'music', 'https://x.test/1'),
                   ('e2', 'Fair', now() + interval '1 day', 'Mislata', 'other', 'https://x.test/2')`;
  await sql`insert into sawk.sources (city, kind, url, label) values ('Гран-Канария', 'web', 'https://x.test/s', 'S')`;
  const keys = async () =>
    Object.fromEntries((await sql`select id, city_key from sawk.events order by id`).map((r) => [r.id, r.city_key]));
  assertEquals(await keys(), { e1: "valencia", e2: "mislata" });
  assertEquals((await sql`select city_key from sawk.sources`)[0].city_key, LPGC);

  await sql`update sawk.events set city = 'Las Palmas' where id = 'e1'`;
  assertEquals((await keys()).e1, LPGC, "a changed city changes the key");

  // Mislata is next to Valencia; an operator who points it there moves its events with it.
  await sql`insert into sawk.city_aliases (alias, key) values ('mislata', 'valencia')`;
  assertEquals((await keys()).e2, "valencia");
  await sql`delete from sawk.city_aliases where alias = 'mislata'`;
  assertEquals((await keys()).e2, "mislata");
  await close();
});

Deno.test("only the database owner can run the city functions or read the tables", async () => {
  const db = await testDb();
  for (const fn of ["city_fold(text)", "city_key(text)", "city_name(text)"]) {
    for (const role of ["anon", "authenticated"]) {
      const [{ ok }] = await db.sql`select has_function_privilege(${role}, ${"sawk." + fn}, 'execute') as ok`;
      assertEquals(ok, false, `${role} can execute ${fn}`);
    }
  }
  for (const table of ["sawk.cities", "sawk.city_aliases"]) {
    for (const role of ["anon", "authenticated"]) {
      const [{ ok }] = await db.sql`select has_table_privilege(${role}, ${table}, 'select') as ok`;
      assertEquals(ok, false, `${role} can read ${table}`);
    }
  }
  await db.close();
});
