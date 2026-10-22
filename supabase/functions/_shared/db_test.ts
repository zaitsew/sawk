import { assertEquals } from "jsr:@std/assert@1";
import { arrayLiteral } from "./db.ts";
import { testDb } from "./testdb.ts";

Deno.test("arrayLiteral: Postgres reads it back as the same text[]", async () => {
  const values = ["ics", "b c", 'q"x', "back\\slash", "", "a,b", "{x}", "NULL"];
  const { sql, close } = await testDb();
  const rows = await sql<{ a: string[] }>`select ${arrayLiteral(values)}::text[] as a`;
  assertEquals(rows[0].a, values);
  assertEquals((await sql<{ a: string[] }>`select ${arrayLiteral([])}::text[] as a`)[0].a, []);
  await close();
});
