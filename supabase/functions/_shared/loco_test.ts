// Tests for the Loco adapter (db/migrations/0002_loco.sql) on PGlite.
// Only synthetic data. The stub tables copy Loco's real column names and types for
// the columns the adapter reads; testDb() applies migrations before they exist.
import { assertEquals } from "jsr:@std/assert@1";
import { testDb } from "./testdb.ts";

const ME = "11111111-1111-4111-8111-111111111111";
const YOU = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const NOBODY = "44444444-4444-4444-8444-444444444444";

const STUBS = `
  create table public.trips (
    id text primary key, doc jsonb not null, slug text not null, title text,
    owner_id uuid, updated_at timestamptz not null default now(), moved_to text);
  create table public.trip_members (
    trip_id text not null references public.trips(id) on delete cascade, user_id uuid not null,
    role text not null, person_id text, archived_at timestamptz, primary key (trip_id, user_id));
  create table public.profiles (user_id uuid primary key, handle text, name text, home_place text);
  create table public.moments (
    id uuid primary key default gen_random_uuid(), trip_id text references public.trips(id) on delete cascade,
    author_id uuid not null, day date not null, about jsonb, rating smallint);
  create table public.taste_prefs (
    user_id uuid primary key, card jsonb not null default '{}'::jsonb, hide text[] not null default '{}',
    share text not null default 'self', updated_at timestamptz not null default now());
`;

const places = [
  { id: "VLC", name: "Valencia", country: "ES", timeZone: "Europe/Madrid", kind: "city" },
  { id: "VCE", name: "Venice", country: "IT", timeZone: "Europe/Rome", kind: "city" },
  { id: "MAD", name: "Madrid", country: "ES", timeZone: "Europe/Madrid", kind: "city" },
  { id: "LIS", name: "Lisbon", country: "PT", timeZone: "Europe/Lisbon", kind: "city" },
];

const people = [{ id: "p-me", name: "A" }, { id: "p-you", name: "B" }];

const tripA = {
  id: "trip-a",
  title: "Synthetic trip A",
  people,
  places,
  stays: [
    {
      id: "s-vce",
      placeId: "VCE",
      checkIn: "2026-11-10",
      checkOut: "2026-11-13",
      who: ["p-me", "p-you"],
      status: "booked",
    },
    { id: "s-mad", placeId: "MAD", checkIn: "2026-11-13", checkOut: "2026-11-15", who: ["p-you"], status: "booked" },
    {
      id: "s-cancel",
      placeId: "LIS",
      checkIn: "2026-11-15",
      checkOut: "2026-11-17",
      who: ["p-me"],
      status: "cancelled",
    },
    { id: "s-idea", placeId: "MAD", checkIn: "2026-11-17", checkOut: "2026-11-19", who: ["p-me"], status: "idea" },
    { id: "s-all", placeId: "LIS", checkIn: "2026-11-20", checkOut: "2026-11-22", who: [], status: "proposed" },
    { id: "s-cross", placeId: "VLC", checkIn: "2026-10-28", checkOut: "2026-11-02", who: ["p-me"] },
    { id: "s-bad", placeId: "NOPE", checkIn: "2026-11-05", checkOut: "2026-11-06", who: ["p-me"] },
    { id: "s-baddate", placeId: "VLC", checkIn: "soon", checkOut: "later", who: ["p-me"] },
  ],
  events: [
    {
      id: "e1",
      placeId: "VCE",
      date: "2026-11-11",
      time: "20:00",
      endTime: "22:00",
      who: ["p-me"],
      title: "Synthetic concert",
      category: "show",
    },
    { id: "e2", placeId: "VCE", date: "2026-11-11", time: "21:00", who: ["p-you"], title: "Not mine" },
    { id: "e3", placeId: "VCE", date: "2026-11-12", who: [], title: "All day thing" },
    {
      id: "e4",
      placeId: "VCE",
      date: "2026-11-12",
      time: "10:00",
      who: ["p-me"],
      title: "Cancelled",
      status: "cancelled",
    },
    { id: "e5", placeId: "VCE", date: "2026-12-05", time: "10:00", who: ["p-me"], title: "Out of range" },
  ],
  moves: [
    {
      id: "m1",
      date: "2026-11-10",
      fromPlaceId: "VLC",
      toPlaceId: "VCE",
      who: ["p-me"],
      status: "booked",
      legs: [{ date: "2026-11-10", dep: "08:55", arr: "11:05", arrDayOffset: 0 }],
    },
    { id: "m2", date: "2026-11-10", fromPlaceId: "VLC", toPlaceId: "MAD", who: ["p-you"], status: "booked" },
  ],
};

const tripIdea = {
  id: "trip-idea",
  title: "Idea",
  phase: "idea",
  people,
  places,
  stays: [{ id: "s", placeId: "LIS", checkIn: "2026-11-05", checkOut: "2026-11-08", who: ["p-me"] }],
  events: [],
  moves: [],
};
const tripNotMine = {
  id: "trip-notmine",
  title: "Not mine",
  people,
  places,
  stays: [{ id: "s", placeId: "LIS", checkIn: "2026-11-05", checkOut: "2026-11-08", who: ["p-me"] }],
  events: [],
  moves: [],
};
const tripMoved = {
  id: "trip-moved",
  title: "Moved",
  people,
  places,
  stays: [{ id: "s", placeId: "LIS", checkIn: "2026-11-05", checkOut: "2026-11-08", who: ["p-me"] }],
  events: [],
  moves: [],
};
const tripArchived = {
  id: "trip-archived",
  title: "Archived",
  people,
  places,
  stays: [{ id: "s", placeId: "LIS", checkIn: "2026-11-05", checkOut: "2026-11-08", who: ["p-me"] }],
  events: [],
  moves: [],
};
// No person_id on the membership: the seat is found through people[].userId.
const tripF = {
  id: "trip-f",
  title: "F",
  people: [{ id: "p-me2", name: "A", userId: ME }],
  places,
  stays: [{ id: "s", placeId: "LIS", checkIn: "2026-11-25", checkOut: "2026-11-27", who: ["p-me2"] }],
  events: [],
  moves: [],
};
// Reviews: events dated before the busy range.
const tripG = {
  id: "trip-g",
  title: "G",
  people,
  places,
  stays: [],
  moves: [],
  events: [
    { id: "g-show1", placeId: "VCE", date: "2025-05-01", who: ["p-me"], title: "a", category: "show" },
    { id: "g-show2", placeId: "VCE", date: "2025-05-02", who: ["p-me"], title: "b", category: "show" },
    { id: "g-sight1", placeId: "VCE", date: "2025-05-03", who: ["p-me"], title: "c", category: "sight" },
    { id: "g-sight2", placeId: "VCE", date: "2025-05-04", who: ["p-me"], title: "d", category: "sight" },
    { id: "g-food1", placeId: "VCE", date: "2025-05-05", who: ["p-me"], title: "e", category: "food" },
    { id: "g-car", placeId: "VCE", date: "2025-05-06", who: ["p-me"], title: "f", category: "car" },
  ],
};
const tripH = {
  id: "trip-h",
  title: "H",
  places,
  stays: [],
  events: [],
  moves: [],
  people: [{ id: "p-h", name: "C", basePlaceId: "VLC" }],
};

type Db = Awaited<ReturnType<typeof testDb>>;

async function seedLoco({ sql, exec }: Db) {
  await exec(STUBS);
  const trip = async (doc: { id: string }, movedTo: string | null = null) => {
    await sql`insert into public.trips (id, doc, slug, moved_to) values (${doc.id}, ${
      sql.json(doc)
    }::jsonb, ${doc.id}, ${movedTo})`;
  };
  const member = async (tripId: string, user: string, person: string | null, archived = false) => {
    await sql`insert into public.trip_members (trip_id, user_id, role, person_id, archived_at)
              values (${tripId}, ${user}, 'traveller', ${person}, ${archived ? new Date() : null})`;
  };
  await trip(tripA);
  await member("trip-a", ME, "p-me");
  await member("trip-a", YOU, "p-you");
  await trip(tripIdea);
  await member("trip-idea", ME, "p-me");
  await trip(tripNotMine);
  await member("trip-notmine", YOU, "p-you");
  await trip(tripMoved, "trip-a");
  await member("trip-moved", ME, "p-me");
  await trip(tripArchived);
  await member("trip-archived", ME, "p-me", true);
  await trip(tripF);
  await member("trip-f", ME, null);
  await trip(tripG);
  await member("trip-g", ME, "p-me");
  await member("trip-g", YOU, "p-you");
  await trip(tripH);
  await member("trip-h", THIRD, "p-h");
}

Deno.test("without Loco's tables every function returns empty or the default", async () => {
  const db = await testDb();
  const { sql } = db;
  assertEquals(await sql`select * from sawk.loco_home(${ME}::uuid)`, []);
  assertEquals(await sql`select * from sawk.loco_windows(${ME}::uuid, '2026-11-01'::date, '2026-11-30'::date)`, []);
  assertEquals(await sql`select * from sawk.loco_busy(${ME}::uuid, '2026-11-01'::date, '2026-11-30'::date)`, []);
  const [{ t }] = await sql`select sawk.loco_taste(${ME}::uuid) as t`;
  assertEquals(t, { reviews: 0, likes: [], avoids: [], byCategory: {}, places: {}, card: null, hide: [] });
  await db.close();
});

Deno.test("only the database owner can run the adapter", async () => {
  const db = await testDb();
  for (
    const fn of ["loco_home(uuid)", "loco_windows(uuid,date,date)", "loco_busy(uuid,date,date)", "loco_taste(uuid)"]
  ) {
    for (const role of ["anon", "authenticated"]) {
      const [{ ok }] = await db.sql`select has_function_privilege(${role}, ${"sawk." + fn}, 'execute') as ok`;
      assertEquals(ok, false, `${role} can execute ${fn}`);
    }
  }
  await db.close();
});

Deno.test("windows: own stays only, nights, clipped, exclusions", async () => {
  const db = await testDb();
  await seedLoco(db);
  const rows = await db.sql`select city, country, tz, starts_on::text as starts_on, ends_on::text as ends_on, trip
      from sawk.loco_windows(${ME}::uuid, '2026-11-01'::date, '2026-11-30'::date)`;
  assertEquals(rows.map((r) => [r.city, r.country, r.tz, r.starts_on, r.ends_on, r.trip]), [
    ["Valencia", "ES", "Europe/Madrid", "2026-11-01", "2026-11-01", "trip-a"], // nights 10-28..11-01, clipped
    ["Venice", "IT", "Europe/Rome", "2026-11-10", "2026-11-12", "trip-a"], // checkout day 11-13 is not a night
    ["Lisbon", "PT", "Europe/Lisbon", "2026-11-20", "2026-11-21", "trip-a"], // empty who = everyone
    ["Lisbon", "PT", "Europe/Lisbon", "2026-11-25", "2026-11-26", "trip-f"], // seat found via people[].userId
  ]);
  // Not on the person's stay, cancelled, idea status, idea trip, not a member, moved, archived: none above.
  const other = await db
    .sql`select city, starts_on::text as starts_on from sawk.loco_windows(${YOU}::uuid, '2026-11-01'::date, '2026-11-30'::date)`;
  assertEquals(
    other.map((r) => [r.city, r.starts_on]).sort(),
    [
      ["Lisbon", "2026-11-20"],
      ["Madrid", "2026-11-13"],
      ["Venice", "2026-11-10"],
    ].sort(),
  );
  assertEquals(
    await db.sql`select * from sawk.loco_windows(${NOBODY}::uuid, '2026-11-01'::date, '2026-11-30'::date)`,
    [],
  );
  assertEquals(await db.sql`select * from sawk.loco_windows(${ME}::uuid, '2027-01-01'::date, '2027-01-31'::date)`, []);
  await db.close();
});

Deno.test("busy: own events and moves in range, in the place's zone", async () => {
  const db = await testDb();
  await seedLoco(db);
  const rows = await db.sql`select day::text as day, title, starts_at, ends_at, city, kind
      from sawk.loco_busy(${ME}::uuid, '2026-11-01'::date, '2026-11-30'::date)`;
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  assertEquals(rows.map((r) => [r.day, r.title, iso(r.starts_at), iso(r.ends_at), r.city, r.kind]), [
    ["2026-11-10", "Valencia → Venice", "2026-11-10T07:55:00.000Z", "2026-11-10T10:05:00.000Z", "Venice", "move"],
    ["2026-11-11", "Synthetic concert", "2026-11-11T19:00:00.000Z", "2026-11-11T21:00:00.000Z", "Venice", "event"],
    ["2026-11-12", "All day thing", null, null, "Venice", "event"],
  ]);
  assertEquals(
    await db.sql`select * from sawk.loco_busy(${ME}::uuid, '2026-12-01'::date, '2026-12-31'::date)`.then((r) =>
      r.map((x) => x.title)
    ),
    ["Out of range"],
  );
  await db.close();
});

Deno.test("taste: means, likes, avoids, card and hide from the person's own reviews", async () => {
  const db = await testDb();
  await seedLoco(db);
  const { sql } = db;
  const review = async (user: string, trip: string, about: unknown, rating: number) => {
    await sql`insert into public.moments (trip_id, author_id, day, about, rating)
              values (${trip}, ${user}, '2025-05-10', ${sql.json(about)}::jsonb, ${rating})`;
  };
  await review(ME, "trip-g", { kind: "event", id: "g-show1" }, 5);
  await review(ME, "trip-g", { kind: "event", id: "g-show2" }, 4);
  await review(ME, "trip-g", { kind: "event", id: "g-sight1" }, 2);
  await review(ME, "trip-g", { kind: "event", id: "g-sight2" }, 3);
  await review(ME, "trip-g", { kind: "event", id: "g-food1" }, 4);
  await review(ME, "trip-g", { kind: "event", id: "g-car" }, 1);
  await review(ME, "trip-g", { kind: "event", id: "gone" }, 5); // the event was deleted: dropped
  await review(ME, "trip-g", { kind: "stay", id: "x" }, 5); // stay not in the document: dropped
  await review(ME, "trip-a", { kind: "stay", id: "s-vce" }, 5);
  await review(ME, "trip-a", { kind: "place", id: "VCE" }, 3);
  await review(YOU, "trip-g", { kind: "event", id: "g-show1" }, 1); // someone else's
  await review(ME, "trip-notmine", { kind: "place", id: "LIS" }, 5); // a trip they are no longer on: dropped
  await sql`insert into public.taste_prefs (user_id, card, hide) values (${ME}, ${
    sql.json({ likes: ["quiet"] })
  }::jsonb, ${["x", "y"]})`;

  const [{ t }] = await sql`select sawk.loco_taste(${ME}::uuid) as t`;
  assertEquals(t, {
    reviews: 8,
    likes: ["theatre"],
    avoids: ["art"],
    byCategory: {
      theatre: { mean: 4.5, n: 2 },
      art: { mean: 2.5, n: 2 },
      food: { mean: 4, n: 1 },
      car: { mean: 1, n: 1 },
    },
    places: { city: { mean: 3, n: 1 } },
    card: { likes: ["quiet"] },
    hide: ["x", "y"],
  });
  const [{ t: other }] = await sql<{ t: Record<string, unknown> }>`select sawk.loco_taste(${YOU}::uuid) as t`;
  assertEquals(other.reviews, 1);
  assertEquals(other.likes, []);
  assertEquals(other.card, null);
  await db.close();
});

Deno.test("home: profile text matched to a place, with a base-place fallback", async () => {
  const db = await testDb();
  await seedLoco(db);
  const { sql } = db;
  await sql`insert into public.profiles (user_id, home_place) values (${ME}, 'lisbon')`;
  await sql`insert into public.profiles (user_id, home_place) values (${YOU}, 'Atlantis')`;
  await sql`insert into public.profiles (user_id, home_place) values (${NOBODY}, 'Valencia, es')`;
  const home = async (u: string) =>
    (await sql`select city, country, tz from sawk.loco_home(${u}::uuid)`).map((r) => [r.city, r.country, r.tz]);
  assertEquals(await home(ME), [["Lisbon", "PT", "Europe/Lisbon"]]);
  assertEquals(await home(YOU), [["Atlantis", null, null]]);
  assertEquals(await home(NOBODY), [["Valencia", "ES", null]]);
  assertEquals(await home(THIRD), [["Valencia", "ES", "Europe/Madrid"]]); // no profile row: base place of the latest trip
  await sql`update public.profiles set home_place = 'Lisbon, CA' where user_id = ${ME}`;
  assertEquals(await home(ME), [["Lisbon", "CA", null]]); // the country written must match the place's
  await db.close();
});
