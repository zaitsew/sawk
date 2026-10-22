import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { eventId, localDate, norm } from "./ids.ts";
import { testDb } from "./testdb.ts";

Deno.test("norm drops accents, case, punctuation and filler", () => {
  assertEquals(norm("¡Concierto: Rosalía en el Roig Arena!"), "rosalia en roig arena");
});

Deno.test("localDate uses the event's own zone", () => {
  assertEquals(localDate("2026-10-24T23:30:00+02:00", "Europe/Madrid"), "2026-10-24");
  assertEquals(localDate("2026-10-24T21:30:00Z", "Europe/Madrid"), "2026-10-24");
  assertEquals(localDate("2026-10-24T23:30:00+02:00"), "2026-10-24");
});

Deno.test("the same event from two sources gets one id", async () => {
  const a = await eventId({ title: "Jazz Night", startsAt: "2026-10-24T22:00:00+02:00", tz: "Europe/Madrid", venue: "Jimmy Glass", city: "Valencia" });
  const b = await eventId({ title: "JAZZ night!", startsAt: "2026-10-24T20:00:00Z", tz: "Europe/Madrid", venue: "Jimmy  Glass", city: "valencia" });
  const c = await eventId({ title: "Jazz Night", startsAt: "2026-10-25T22:00:00+02:00", tz: "Europe/Madrid", venue: "Jimmy Glass", city: "Valencia" });
  assertEquals(a, b);
  assertNotEquals(a, c);
});

Deno.test("migrations apply and the schema is closed to anon", async () => {
  const { sql, close } = await testDb();
  const rows = await sql`select count(*)::int as n from information_schema.tables where table_schema = 'sawk'`;
  assertEquals(rows[0].n, 9);
  const grants = await sql`select count(*)::int as n from information_schema.role_table_grants where table_schema = 'sawk' and grantee in ('anon', 'authenticated')`;
  assertEquals(grants[0].n, 0);
  await close();
});
