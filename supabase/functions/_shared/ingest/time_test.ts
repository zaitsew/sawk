import { assertEquals } from "jsr:@std/assert@1";
import { addDays, defaultTz, instantToWall, isValidTz, todayIn, tzOffsetMs, wallToInstant } from "./time.ts";

Deno.test("zones: valid, offset across the DST change, wall to instant both ways", () => {
  assertEquals([isValidTz("Europe/Madrid"), isValidTz("Mars/Olympus"), isValidTz(null)], [true, false, false]);
  assertEquals(tzOffsetMs(Date.parse("2026-07-01T00:00:00Z"), "Europe/Madrid"), 2 * 3_600_000);
  assertEquals(tzOffsetMs(Date.parse("2026-12-01T00:00:00Z"), "Europe/Madrid"), 3_600_000);
  const wall = Date.parse("2026-10-24T20:00:00Z"); // "20:00 on the clock"
  assertEquals(new Date(wallToInstant(wall, "Europe/Madrid")).toISOString(), "2026-10-24T18:00:00.000Z");
  assertEquals(instantToWall(Date.parse("2026-10-24T18:00:00Z"), "Europe/Madrid"), wall);
  // the night the clocks go back (2026-10-25 03:00 -> 02:00) and the spring gap (2026-03-29 02:00 -> 03:00)
  assertEquals(
    new Date(wallToInstant(Date.parse("2026-10-25T12:00:00Z"), "Europe/Madrid")).toISOString(),
    "2026-10-25T11:00:00.000Z",
  );
  assertEquals(
    new Date(wallToInstant(Date.parse("2026-03-29T12:00:00Z"), "Europe/Madrid")).toISOString(),
    "2026-03-29T10:00:00.000Z",
  );
});

Deno.test("todayIn uses the zone's calendar day", () => {
  const now = new Date("2026-10-23T23:30:00Z");
  assertEquals(todayIn(now, "Europe/Madrid"), "2026-10-24");
  assertEquals(todayIn(now, "UTC"), "2026-10-23");
  assertEquals(todayIn(now, null), "2026-10-23");
  assertEquals(addDays("2026-10-31", 1), "2026-11-01");
  assertEquals(addDays("2026-03-01", -1), "2026-02-28");
});

Deno.test("default zone: city first, then country", () => {
  assertEquals(defaultTz("València", "ES"), "Europe/Madrid");
  assertEquals(defaultTz("Valencia", null), "Europe/Madrid");
  assertEquals(defaultTz("Nowhere", "PT"), "Europe/Lisbon");
  assertEquals(defaultTz("Nowhere", null), null);
});
