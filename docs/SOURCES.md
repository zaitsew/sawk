# Sources

Where SAWk's events come from, how each source was checked, and how the daily
ingest runs. The starting set is Valencia, Spain (migration
`db/migrations/0003_sources_seed.sql`). Adding a city is adding rows to
`sawk.sources` (agents do it with `sawk_add_source`); nothing in the code is
specific to Valencia.

## How a source is read

| kind | what it is | who reads it |
|---|---|---|
| `ics` | an iCalendar feed (Meetup groups, venue calendars) | the ingest, daily |
| `jsonld` | a web page with schema.org `Event` JSON-LD | the ingest, daily |
| `ticketmaster` | a Ticketmaster Discovery API city query; needs `TICKETMASTER_API_KEY`, skipped without it | the ingest, daily |
| `rss`, `web` | pages with no machine-readable events | agents only; the ingest skips them |

One daily call to the `sawk-ingest` edge function reads every active `ics`,
`jsonld` and `ticketmaster` row, upserts into `sawk.events`, records one
`sawk.runs` row (`agent = 'ingest'`), updates each source's `last_ok_at`,
`last_error` and `last_count`, and then writes a rule-based fallback rank into
`sawk.feed`. It never calls a model.

Rules every adapter shares:

- An event's id comes from title, local date, venue and city, so the same
  concert seen on two sources lands on one row. A sighting with no venue joins
  the row with the same title, day and city.
- Events that are over, or more than 400 days ahead, are dropped. City, country
  and time zone default from the source row.
- Recurring ICS events (`DAILY`, `WEEKLY`, `MONTHLY`, with `INTERVAL`, `COUNT`,
  `UNTIL`, `BYDAY`, `BYMONTHDAY`, `EXDATE`, overrides, cancellations) expand
  for the next 60 days. Any other rule is read as a single event.
- Online-only events are dropped. A cancelled event is kept only if it was
  already known, and is hidden from the feed. An `EXDATE` inside the 60-day
  window is emitted as a cancelled occurrence, so a row imported earlier is
  marked. The source that cancelled an event is recorded in the event's `seen`
  list, and only that source can un-cancel it.
- Rows are read again with a lock just before they are merged, so a field an
  agent filled in meanwhile is merged, never overwritten.
- A failing source records its error and does not stop the run. A run is
  `failed` only when every attempted source failed.

Politeness and safety:

- The User-Agent is `SAWk/0.1 (+https://github.com/zaitsew/sawk)`. A page is
  fetched with a 15 s timeout and a 3 MB cap. Sources on one host run one at a
  time, a second apart; at most 6 hosts run in parallel.
- `jsonld` pages are fetched only if the host's `robots.txt` allows the path
  (RFC 9309: our own `sawk` group, else `*`; longest match wins). A 4xx answer
  for `robots.txt` allows; a 5xx or network error skips the page for that run.
- **The ingest reads only from an allow-list of hosts** (`INGEST_HOSTS` in
  `supabase/functions/_shared/ingest/hosts.ts`). Source rows are shared and
  anyone can add one, so the daily job does not fetch whatever a row says.
  A listed domain covers its subdomains; `evilmeetup.com` and
  `meetup.com.evil.test` do not match. Every redirect hop is checked against the
  list too. A machine-readable source on any other host is skipped with
  `last_error = 'host not on the ingest allow-list (agents can still read it)'`;
  it does not make the run partial, and agents can still read the page.
- On top of the list, the fetch refuses anything that is not a public http(s)
  address: localhost and internal names, private, loopback and link-local IP
  literals, and names that resolve to such addresses. Redirects are followed by
  hand, at most 5. The list is what closes DNS rebinding: a listed host's name
  cannot be pointed at a private address without that host's operator.
  The ingest only reads and sends no credentials.
- A site's terms of service are the operator's to read. `robots.txt` permitted
  the paths below on 2026-10-23; that is not a licence to the content. Events
  keep their source URL (`url`, `seen`) and SAWk shows facts, not whole pages.

### The allow-list

| Domain | Used by |
|---|---|
| `meetup.com` | the Meetup `ics` feeds |
| `eventbrite.es` | the Eventbrite pages |
| `songkick.com` | Songkick pages |
| `bandsintown.com` | Bandsintown pages |
| `ticketmaster.es` | the Ticketmaster.es discover page |
| `allevents.in` | AllEvents |
| `app.ticketmaster.com` | the Ticketmaster Discovery API |

To read a new site every day: check its `robots.txt` and terms, add its
registrable domain to `INGEST_HOSTS` and to this table, add the source row, and
add a seed or test line showing it parses. Otherwise make the row a `web` source
and let agents read it.

## Verified on 2026-10-23

Each row was fetched live through the real adapters (city Valencia). "Found" is
the number of events read; "kept" is what remains after dropping events that
are over or too far ahead.

### `ics` (8)

| Source | Found | Kept |
|---|---|---|
| Meetup · Awakatech (`awakatech`) | 1 | 1 |
| Meetup · Book Lovers Valencia (`bookloversvalencia`) | 10 | 10 |
| Meetup · Valencia Nomads Club (`digital-nomads-founders-valencia`) | 10 | 10 |
| Meetup · Encuentros filosóficos (`encuentros-filosoficos`) | 1 | 1 |
| Meetup · Language exchange events (`language-exchanges-events`) | 10 | 10 |
| Meetup · Thoughtful connections (`thoughtful-connections-valencia`) | 6 | 6 |
| Meetup · Valencia International Community (`valencia-international-community`) | 6 | 6 |
| Meetup · Valencia walks and talks (`valencia-walks-talks`) | 6 | 6 |

Meetup serves each public group's feed at `/<group>/events/ical/`. A group with
no upcoming events returns an empty feed, so counts move day to day.

### `jsonld` (17)

| Source | Found | Kept |
|---|---|---|
| Eventbrite · Valencia (all) | 51 | 45 |
| Eventbrite · music | 8 | 8 |
| Eventbrite · nightlife | 20 | 20 |
| Eventbrite · performing and visual arts | 20 | 20 |
| Eventbrite · food and drink | 8 | 8 |
| Eventbrite · science and tech | 8 | 8 |
| Eventbrite · business | 8 | 8 |
| Eventbrite · sports and fitness | 8 | 8 |
| Eventbrite · community | 8 | 8 |
| Eventbrite · family and education | 8 | 8 |
| Eventbrite · film and media | 8 | 8 |
| Eventbrite · free | 20 | 20 |
| Songkick · Valencia concerts | 50 | 48 |
| Songkick · Valencia concerts, page 2 | 50 | 50 |
| Bandsintown · Valencia | 36 | 36 |
| Ticketmaster.es · Valencia (discover page) | 20 | 20 |
| AllEvents · Valencia | 65 | 63 |

The same event often appears in several of these; the ingest merges them, so
the number of rows in `sawk.events` is lower than the sum of "kept".

### `ticketmaster` (1)

`ticketmaster:city=Valencia&countryCode=ES`. **Not verified against the live
API:** no key was available when this was written. The adapter follows the
documented Discovery API v2 response, and its tests use a fixture in that
shape. Get a free key at developer.ticketmaster.com and set
`TICKETMASTER_API_KEY`; until then the source is skipped (it shows
`last_error = 'no key'` and does not make a run partial). The API is limited
to 5 requests per second; the adapter reads at most 3 pages of 200.

### `web` (9, agents only)

Read by agents, not by the ingest. None has machine-readable events today.

| Source | Why it is here |
|---|---|
| Visit València · agenda | the city's official agenda |
| Culturplaza (Valencia Plaza) | culture and entertainment listings |
| IVAM · exhibitions | the modern art museum |
| Roig Arena · events | the large arena's programme |
| 16 Toneladas | live music club |
| La Rambleta | theatre, family and music programme |
| Bombas Gens | art centre |
| Mercado de Colón · events | market with events (has `Event` JSON-LD, but only past events on the day it was checked) |
| Valencia Basket · fixtures | home games |

## Tried and left out

| Source | Why |
|---|---|
| Meetup "find" pages | `robots.txt` disallows the search parameters (`location`, `keywords`, `source`) |
| Atrápalo | answers with a bot challenge; not worked around |
| Resident Advisor | HTTP 403 |
| Palau de les Arts, CaixaForum | HTTP 402 / 403 |
| Les Arts, IVAM, Roig Arena, La Rambleta, Bombas Gens, Las Naves, Visit València, Valencia Plaza, Luma | listing pages have no `Event` JSON-LD (kept as `web` where useful) |
| A football club's fixtures feed | includes away games and has no location |
| Two Meetup groups found in a first search | not about events in Valencia (a matchmaking group abroad, a dating-style group) |

## Running it

The pieces, once per project:

1. Apply the migrations (`deno task migrate`, which runs `0003` and `0004`).
2. Pick a long random string for the cron secret. Set it on the function and in
   Vault (the database sends it, the function checks it):

   ```bash
   supabase secrets set SAWK_CRON_SECRET=<random string> --project-ref <ref>
   ```

   ```sql
   select vault.create_secret('<random string>',                    'sawk_cron_secret');
   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'sawk_functions_url');
   ```

3. Deploy the function without JWT verification (the caller is the database,
   authenticated by the shared secret):

   ```bash
   supabase functions deploy sawk-ingest --no-verify-jwt --project-ref <ref>
   ```

4. Optional: `supabase secrets set TICKETMASTER_API_KEY=<key>`.

`pg_cron` then calls `sawk.ingest_kick()` every day at 04:30 UTC. Check the
last run with `select * from sawk.runs where agent = 'ingest' order by started_at desc limit 1`,
or a source's health with `select label, last_ok_at, last_error, last_count from sawk.sources`.
Run one source by hand:

```bash
curl -X POST -H "x-sawk-cron: $SAWK_CRON_SECRET" \
  "https://<ref>.supabase.co/functions/v1/sawk-ingest?source=<sources.id>"
```

Without `pg_cron`, `pg_net` or Vault (a plain self-hosted Postgres) migration
`0004` still applies; it only creates the function. Call the endpoint from your
own scheduler with the `x-sawk-cron` header.

## The fallback rank

After the sources are read, every profile gets a rule-based rank so the feed is
never empty before an agent has run. It is written with `ranked_by = 'fallback'`,
only where no agent (or person) has a rank for that event, and it never touches
`state` or `rating`. Per day, it keeps the best `max_per_day × 3` events in the
cities the person is in that day (home, `sawk.windows`, Loco trips). The score
starts at 0.3 and moves with likes and avoids from the profile, what the person
saved, went to or hid before (by category and venue), the price limit, free
entry, and busy days from Loco.
