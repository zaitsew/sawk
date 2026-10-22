import { describe, expect, it } from "vitest";
import { cityLine, dayKey, groupByDay, isPast, rangeLabel, timeLabel, windowFor } from "./days";
import { fx } from "./fixtures";

const MAD = "Europe/Madrid";

describe("dayKey", () => {
  it("keeps an event at 23:30 Madrid on its Madrid day, whatever the viewer's zone", () => {
    const iso = "2026-10-24T23:30:00+02:00"; // 21:30Z
    expect(dayKey(iso, MAD)).toBe("2026-10-24");
    expect(dayKey(iso, "UTC")).toBe("2026-10-24");
    expect(dayKey(iso, "Asia/Tokyo")).toBe("2026-10-25"); // the viewer's clock would move it
  });
  it("keeps 00:30 Madrid on the new day although UTC is still yesterday", () => {
    const iso = "2026-10-25T00:30:00+02:00"; // 22:30Z on the 24th
    expect(dayKey(iso, MAD)).toBe("2026-10-25");
    expect(dayKey(iso, "UTC")).toBe("2026-10-24");
  });
  it("follows the DST change (Madrid goes to UTC+1 on 25 Oct 2026)", () => {
    expect(dayKey("2026-10-25T23:30:00+01:00", MAD)).toBe("2026-10-25");
    expect(dayKey("2026-10-24T22:30:00Z", MAD)).toBe("2026-10-25");
  });
});

describe("groupByDay", () => {
  const now = Date.parse("2026-10-24T12:00:00+02:00");
  const opts = { now, maxPerDay: 2, fallbackTz: MAD };

  it("groups by the event's own day, in order", () => {
    const g = groupByDay([
      fx({ id: "late", startsAt: "2026-10-24T23:30:00+02:00" }),
      fx({ id: "after", startsAt: "2026-10-25T00:30:00+02:00" }),
      fx({ id: "tomorrow", startsAt: "2026-10-25T19:00:00+01:00" }),
    ], opts);
    expect(g.map((x) => x.day)).toEqual(["2026-10-24", "2026-10-25"]);
    expect(g[0].all.map((i) => i.event.id)).toEqual(["late"]);
    expect(g[1].all.map((i) => i.event.id)).toEqual(["after", "tomorrow"]);
  });

  it("shows the top maxPerDay by score, in time order, and the rest as more", () => {
    const g = groupByDay([
      fx({ id: "a", startsAt: "2026-10-26T10:00:00+01:00", score: 0.2 }),
      fx({ id: "b", startsAt: "2026-10-26T12:00:00+01:00", score: 0.9 }),
      fx({ id: "c", startsAt: "2026-10-26T14:00:00+01:00", score: 0.5 }),
      fx({ id: "d", startsAt: "2026-10-26T16:00:00+01:00", score: 0.8 }),
    ], opts)[0];
    expect(g.shown.map((i) => i.event.id)).toEqual(["b", "d"]);
    expect(g.more.map((i) => i.event.id)).toEqual(["a", "c"]);
    expect(g.all.map((i) => i.event.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("labels today, tonight, tomorrow and later days", () => {
    const g = groupByDay([
      fx({ id: "t", startsAt: "2026-10-24T22:00:00+02:00" }),
      fx({ id: "m", startsAt: "2026-10-25T20:00:00+01:00" }),
      fx({ id: "l", startsAt: "2026-10-28T20:00:00+01:00" }),
    ], opts);
    expect(g.map((x) => x.label)).toEqual(["Tonight", "Tomorrow", "Wed 28 Oct"]);
    const day = groupByDay([fx({ startsAt: "2026-10-24T13:00:00+02:00" })], opts);
    expect(day[0].label).toBe("Today");
  });

  it("puts an all-day event on its own date", () => {
    const g = groupByDay([fx({ allDay: true, startsAt: "2026-10-27T00:00:00+01:00" })], opts);
    expect(g[0].day).toBe("2026-10-27");
  });
});

describe("windows", () => {
  const home = { city: "Valencia", country: "ES", tz: MAD, from: "2026-10-01", to: "2026-12-31", source: "home" as const };
  const tokyo = { city: "Tokyo", country: "JP", tz: "Asia/Tokyo", from: "2026-12-08", to: "2026-12-21", source: "loco" as const, id: "trip" };
  it("prefers a trip to home on the days it covers", () => {
    expect(windowFor("2026-12-10", [home, tokyo])?.city).toBe("Tokyo");
    expect(windowFor("2026-12-22", [home, tokyo])?.city).toBe("Valencia");
    expect(windowFor("2027-02-01", [home, tokyo])).toBeNull();
  });
  it("writes a city line only away from home", () => {
    expect(cityLine(tokyo)).toBe("In Tokyo · Dec 8–21");
    expect(cityLine(home)).toBeNull();
    expect(cityLine(null)).toBeNull();
  });
  it("formats ranges across months", () => {
    expect(rangeLabel("2026-12-28", "2027-01-04")).toBe("Dec 28 – Jan 4");
    expect(rangeLabel("2026-12-08", "2026-12-08")).toBe("Dec 8");
  });
});

describe("timeLabel", () => {
  const e = { startsAt: "2026-10-24T22:00:00+02:00", allDay: false, tz: MAD };
  it("shows the wall clock where the event is", () => {
    expect(timeLabel(e, MAD, MAD)).toBe("22:00");
  });
  it("adds the viewer's clock when the zones differ", () => {
    expect(timeLabel(e, MAD, "America/New_York")).toBe("22:00 · 16:00 your time");
    expect(timeLabel(e, MAD, "Asia/Tokyo")).toBe("22:00 · 05:00 your time, next day");
  });
  it("says all day", () => {
    expect(timeLabel({ ...e, allDay: true }, MAD, MAD)).toBe("All day");
  });
});

describe("isPast", () => {
  const now = Date.parse("2026-10-24T22:00:00+02:00");
  it("uses the end when there is one, else start + 3 h", () => {
    expect(isPast({ startsAt: "2026-10-24T20:00:00+02:00", endsAt: "2026-10-24T21:00:00+02:00", allDay: false, tz: MAD }, now, MAD)).toBe(true);
    expect(isPast({ startsAt: "2026-10-24T20:00:00+02:00", endsAt: null, allDay: false, tz: MAD }, now, MAD)).toBe(false);
    expect(isPast({ startsAt: "2026-10-24T17:00:00+02:00", endsAt: null, allDay: false, tz: MAD }, now, MAD)).toBe(true);
  });
  it("keeps an all-day event until its day is over", () => {
    expect(isPast({ startsAt: "2026-10-24T00:00:00+02:00", endsAt: null, allDay: true, tz: MAD }, now, MAD)).toBe(false);
    expect(isPast({ startsAt: "2026-10-23T00:00:00+02:00", endsAt: null, allDay: true, tz: MAD }, now, MAD)).toBe(true);
  });
});
