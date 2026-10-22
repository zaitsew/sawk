# Architecture

SAWk keeps one person's offline-event feed: what is on in the city they live in and the
cities they travel to, ranked for them, with a reason per item. Agents do the reading and
ranking on a schedule; SAWk is the place they read context from and write results to.

```
 Claude Code ┐  scheduled run (skills/sawk)         ┌── web feed (web/, PWA)
 Codex       ├─ MCP ──► sawk function ─► Postgres ◄─┼── Loco (REST, same sign-in)
 ChatGPT     │  /mcp      /api            schema    └── any MCP chat: "what's on tonight?"
 Grok        ┘                            `sawk`
                         sawk-ingest ──► ICS · JSON-LD · Ticketmaster   (daily, no LLM)
```

## Parts

| part | path | what it does |
|---|---|---|
| schema | `db/migrations/*.sql` | the data model (`0001_init.sql` is the contract) |
| migrate | `scripts/migrate.ts` | applies `db/migrations` in order, ledger in `sawk.migrations` |
| `sawk` function | `supabase/functions/sawk/` | `/mcp` (Streamable HTTP MCP) and `/api/*` (REST), one auth layer |
| `sawk-ingest` | `supabase/functions/sawk-ingest/` | daily: pulls machine-readable sources, upserts events, fallback ranking |
| shared | `supabase/functions/_shared/` | `db.ts` (postgres.js on `SUPABASE_DB_URL`), `ids.ts`, `types.ts` |
| skill | `skills/sawk/SKILL.md` | the scheduled-run procedure every harness follows |
| prompts | `prompts/` | the same procedure as a pasteable task for ChatGPT and Grok |
| web | `web/` | Vite + React PWA: feed, save/hide/going/rate, profile, agent tokens |

## Deployment (the owner's)

SAWk runs inside Loco's Supabase project, in schema `sawk` only. Loco's sign-in is SAWk's
sign-in, and Loco's OAuth 2.1 server (agents connect with it) issues tokens SAWk accepts.
Any other Supabase project works the same way: without Loco's tables, the Loco adapter
(`0002_loco.sql`) returns nothing and windows come from `sawk.windows`. See
`docs/DECISIONS.md` 2026-10-23.

The functions reach Postgres directly with `SUPABASE_DB_URL` (set by Supabase in every
edge function), not through PostgREST, so schema `sawk` is never exposed over the REST API.

## Auth

`Authorization: Bearer <token>` on every call, one of:

- **A Supabase user JWT** of the project (a session, or an OAuth agent token from the
  project's OAuth server). Verified against the project's JWKS, issuer
  `<SUPABASE_URL>/auth/v1`, `role: authenticated`. Same check as Loco's
  `supabase/functions/loco-mcp/auth.ts`.
- **A SAWk personal access token** `sawk_pat_<32 base62>`, for headless scheduled runs.
  Looked up by SHA-256 in `sawk.tokens`; revoked tokens fail; `last_used_at` is touched.

Either gives a `userId`. Every query is filtered by it. No caller can read another
person's profile, feed, feedback, runs or tokens. Events and sources are shared.

## MCP tools (`/mcp`)

All tools take and return JSON. Dates are `YYYY-MM-DD`, times ISO 8601 with offset.

| tool | input | returns |
|---|---|---|
| `sawk_context` | `{days?: 1..60 = 21}` | everything a run needs: `profile`, `windows` (home + trips, each `{city, country, tz, from, to, source}`), `busy` (days already planned, from Loco), `taste` (Loco ratings summary), `history` (last 90 days of feedback: counts per category and action, the last 30 titles saved/going/hidden/rated), `sources` (per window city), `pool` (events already known per city in the window), `lastRuns` (3) |
| `sawk_run_start` | `{agent, model?, cities?}` | `{runId}` |
| `sawk_run_finish` | `{runId, status: ok\|partial\|failed, notes?}` | the run row |
| `sawk_events` | `{city, from, to, category?, limit? = 200}` | pool events in that window |
| `sawk_add_events` | `{runId, events: EventIn[] (≤100)}` | `{added, updated, rejected: [{index, why}] , ids}` |
| `sawk_rank` | `{runId, items: [{eventId, score 0..1, reason}] (≤200)}` | `{ranked}`; keeps the person's state and rating |
| `sawk_feed` | `{from?, to?, city?, state?, limit? = 30}` | ranked feed items with their events |
| `sawk_feedback` | `{eventId, action, rating?, note?}` | the feed row after it |
| `sawk_profile` | `{set?: Partial<Profile>}` | the profile (after the update) |
| `sawk_add_source` | `{city, country?, kind, url, label, categories?}` | the source row |
| `sawk_add_window` | `{city, country?, tz?, from, to, note?}` | the window row |

`EventIn` (validated server-side; one bad event is rejected, not the batch):

```jsonc
{ "title": "Jazz at Jimmy Glass",           // required
  "startsAt": "2026-10-24T22:00:00+02:00",  // required, with offset; must be in the future (≥ now − 6 h)
  "endsAt": null, "allDay": false, "tz": "Europe/Madrid",
  "city": "Valencia", "country": "ES",      // city required
  "venue": "Jimmy Glass Jazz Bar", "address": "Carrer de Baja, 28", "lat": null, "lon": null,
  "category": "music",                      // one of the schema's list; unknown → "other"
  "tags": ["jazz", "live"], "priceMin": 12, "priceMax": 15, "currency": "EUR", "isFree": false,
  "url": "https://…",                       // required: where the agent read it
  "ticketUrl": null, "imageUrl": null, "lang": "es", "description": "≤ 600 chars" }
```

## REST (`/api`)

For the web feed and Loco. Same auth, JSON bodies, same shapes as the MCP tools.

| method | path | same as |
|---|---|---|
| GET | `/api/context?days=` | `sawk_context` |
| GET | `/api/feed?from=&to=&city=&state=&limit=` | `sawk_feed` |
| POST | `/api/feedback` | `sawk_feedback` |
| GET, PUT | `/api/profile` | `sawk_profile` |
| GET, POST, DELETE | `/api/windows[/:id]` | `sawk_add_window` + list + delete |
| GET | `/api/runs?limit=` | the person's runs, newest first |
| GET, POST, DELETE | `/api/tokens[/:id]` | list (no hash), create (the token is shown once), revoke |
| GET | `/api/health` | `{ok: true, version}` (no auth) |

## Ranking

The agent ranks. The server never calls a model (no metered spend; scheduled runs use
the person's own Claude, ChatGPT, Codex or Grok subscription). When no agent ranked an
event in a window, `sawk-ingest` writes a **fallback** score from profile tags, avoids,
category history and price cap, with `ranked_by = 'fallback'` and a plain reason ("Matches
'jazz'"). An agent's rank always replaces a fallback; a fallback never replaces an agent's.

## Loco

- **Reads Loco, never writes it.** `sawk.loco_home(user)`, `sawk.loco_windows(user, from,
  to)`, `sawk.loco_busy(user, from, to)`, `sawk.loco_taste(user)` (`0002_loco.sql`) read trips,
  stays, events and moments for the person's own trips. Each returns empty when Loco's tables
  are absent. The field list and rules are in `docs/LOCO.md`.
- **Loco reads SAWk** through `/api/feed` with the person's Loco session (the same JWT).
  The Loco side lives in Loco's repo.
