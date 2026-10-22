# What SAWk reads from Loco

SAWk reads Loco and never writes it. The reads live in `db/migrations/0002_loco.sql` as four
functions in schema `sawk`. They run as the database owner (`security definer`), and only the
`sawk` edge function calls them. Every read of a Loco table is dynamic SQL, so the file applies
and runs where Loco does not exist; without Loco's tables each function returns nothing.

## Which person, which trips

- A trip counts when the person has a `trip_members` row for it.
- The person's seat on the trip is `trip_members.person_id`. If that is empty, the entry in
  the trip document's `people[]` whose `userId` is the person.
- No seat, no data from that trip.
- An item (stay, event, move) is the person's when its `who` lists their seat. An empty or
  missing `who` means everyone on the trip, as in Loco.

Left out:

| what | how it is detected |
|---|---|
| trips in phase `idea` | `doc.phase = 'idea'` |
| trips moved to a newer trip | `trips.moved_to` is set (skipped if the column is absent) |
| trips the person archived | `trip_members.archived_at` is set (skipped if the column is absent) |
| cancelled or idea stays, events, moves | item `status` is `cancelled` or `idea` |
| items with unreadable dates | a date that is not `YYYY-MM-DD` |

Loco has no trip-level trash: `trip_trash` holds removed items, which are already gone from
the document.

## Fields read

| function | Loco source | used for |
|---|---|---|
| `loco_home(user)` | `profiles.home_place` (free text: a city name, optionally `City, CC`); the matching place in the person's own trips for country and `timeZone`; else the base place (`people[].basePlaceId`) of their latest trip | home city, country, tz |
| `loco_windows(user, from, to)` | `trips.doc` `stays[]` (`placeId`, `checkIn`, `checkOut`, `who`, `status`), `places[]` (`name`, `country`, `timeZone`), the trip slug | where the person sleeps |
| `loco_busy(user, from, to)` | `events[]` (`date`, `time`, `endTime`, `title`, `placeId`, `who`, `status`), `moves[]` (`date`, `fromPlaceId`, `toPlaceId`, `legs[].dep/arr/date/arrDayOffset`) | what is already planned |
| `loco_taste(user)` | `moments` (`author_id`, `about`, `rating`) resolved against `trips.doc`; `taste_prefs` (`card`, `hide`) | what the person rates highly |

SAWk never reads stay names, addresses, booking references, access codes, prices, notes,
files, chat, other people's names or other people's moments. The trip is identified by its slug,
never its title.

## Night to city

A stay covers the nights `checkIn` to `checkOut - 1`, both days included. The checkout day
belongs to the next place, or to home. A stay with `checkOut <= checkIn` covers its check-in
day. `loco_windows` returns one row per stay (adjacent stays in one city stay separate rows),
clipped to the requested range. Home days are not rows.

## Busy

- An event with `time` gets `starts_at` in its place's time zone. `endTime` sets `ends_at`,
  on the next day if it is not later than `time`. An event without a time is all-day
  (`starts_at` null). A place without a known zone also leaves `starts_at` null.
- A move is one row on its `date`, title `From → To`, kind `move`, city = where it arrives.
  Its times come from the first leg's `dep` and the last leg's `arr` (plus `arrDayOffset`).

## Taste

A review is a moment with an `about` (`stay`, `move`, `event` or `place`) and a rating of 1 to
5, written by the person. A review whose item is not in the trip document is dropped.

- Event categories map to SAWk's: `sight` to `art`, `show` to `theatre`, `nature` to
  `outdoor`, `shopping` to `market`, `food` and `sport` unchanged. Other Loco words stay as
  they are (`meeting`, `car`, `transport`, `other`).
- `byCategory` lists every category with its mean (one decimal) and count.
- `likes` are categories with a mean of 4.0 or more, `avoids` 2.5 or less, both only with
  at least 2 reviews, as `makeTaste` in Loco's `packages/mcp/src/taste.ts`.
- `places` is the same by place kind. `reviews` counts every kept review, any kind.
- `card` and `hide` come from `taste_prefs`; `card` is null when empty.

## Loco migrations this relies on

`20260904120000_loco_v1` (`trips`), `20260904200000_loco_v2_identity_schema`
(`trip_members`, `profiles.home_place`, `trips.slug`), `20260917100000_moments` (`moments`),
`20261005031000_place_marks_guides` (`taste_prefs`), and, when present,
`20260930120000_trip_archive` (`archived_at`) and `20261009120000_calendar_feed` (`moved_to`).
