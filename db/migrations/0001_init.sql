-- SAWk 0001 — the whole data model.
--
-- Everything lives in schema `sawk`, so SAWk can share a Supabase project with
-- another product (Loco) without touching its tables. Nothing here references
-- auth.users: a self-hosted SAWk on plain Postgres works the same way. User ids
-- are the Supabase auth ids of whichever project issues the tokens.
--
-- Access goes through the `sawk` edge function only (it connects as the
-- database owner). Row security is on with no policies, and anon/authenticated
-- get no grants, so PostgREST exposes nothing even if the schema is exposed.

create schema if not exists sawk;

create table if not exists sawk.migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

-- One row per person: who they are as an event-goer. Written by the person
-- (web, Loco) or by an agent on their behalf (sawk_profile).
create table sawk.profiles (
  user_id      uuid primary key,
  home_city    text,                          -- "Valencia"
  home_country text,                          -- ISO 3166-1 alpha-2, "ES"
  home_tz      text,                          -- IANA, "Europe/Madrid"
  langs        text[] not null default '{en}', -- languages they enjoy events in
  likes        text[] not null default '{}',  -- short tags: "jazz", "tech meetups", "natural wine"
  avoids       text[] not null default '{}',  -- "stand-up", "techno", "kids"
  notes        text   not null default '',    -- free text in their own words, read by agents
  price_max    numeric,                       -- per ticket, in currency below; null = no cap
  currency     text   not null default 'EUR',
  max_per_day  smallint not null default 3,   -- feed items per day shown first
  updated_at   timestamptz not null default now()
);

-- Where the person will be, beyond home. Loco trips arrive through
-- sawk.loco_windows() (0002) when SAWk runs inside Loco's project; these rows
-- are for everything else (self-host, a trip Loco does not know about).
create table sawk.windows (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null,
  city      text not null,
  country   text,
  tz        text,
  starts_on date not null,
  ends_on   date not null,
  note      text,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index windows_user on sawk.windows (user_id, starts_on);

-- Where events come from. Shared by everyone in a city: an ICS feed of a
-- venue, a page with schema.org/Event JSON-LD, a Ticketmaster city query.
-- `web` is a page only agents read (no machine-readable events on it).
create table sawk.sources (
  id          uuid primary key default gen_random_uuid(),
  city        text not null,
  country     text,
  kind        text not null check (kind in ('ics', 'jsonld', 'ticketmaster', 'rss', 'web')),
  url         text not null,
  label       text not null,
  categories  text[] not null default '{}',
  active      boolean not null default true,
  added_by    uuid,                          -- null = seeded with the repo
  last_ok_at  timestamptz,
  last_error  text,
  last_count  integer,
  created_at  timestamptz not null default now(),
  unique (kind, url)
);
create index sources_city on sawk.sources (lower(city)) where active;

-- The shared pool of public events. Facts only, no opinion: who it suits is
-- sawk.feed. `id` is sawk_event_id(title, local start date, venue, city),
-- computed by the writer (see supabase/functions/_shared/ids.ts), so the same
-- concert from two sources lands on one row.
create table sawk.events (
  id           text primary key,
  title        text not null,
  description  text,
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  all_day      boolean not null default false,
  tz           text,
  city         text not null,
  country      text,
  venue        text,
  address      text,
  lat          double precision,
  lon          double precision,
  category     text not null default 'other' check (category in (
                 'music', 'nightlife', 'art', 'theatre', 'film', 'talk', 'meetup', 'tech',
                 'food', 'sport', 'market', 'festival', 'family', 'outdoor', 'other')),
  tags         text[] not null default '{}',
  price_min    numeric,
  price_max    numeric,
  currency     text,
  is_free      boolean,
  url          text not null,                -- where a person reads about it; provenance
  ticket_url   text,
  image_url    text,
  lang         text,
  cancelled    boolean not null default false,
  -- Every sighting: [{"via": "ics:<source id>" | "agent:<run id>", "url": "...", "at": "..."}]
  seen         jsonb not null default '[]',
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index events_city_time on sawk.events (lower(city), starts_at);

-- A run: one scheduled pass by an agent (Claude Code, Codex, ChatGPT, Grok) or
-- by the server's own ingest. The record that answers "did it run?".
create table sawk.runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid,                        -- null for the server ingest
  agent         text not null,               -- "claude-code", "codex", "chatgpt", "grok", "ingest"
  model         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  cities        text[] not null default '{}',
  events_added  integer not null default 0,
  events_seen   integer not null default 0,
  ranked        integer not null default 0,
  notes         text
);
create index runs_user_time on sawk.runs (user_id, started_at desc);

-- The personal feed: one row per (person, event) someone ranked. Ranking
-- rewrites score/reason; the person's state and rating are never overwritten
-- by a ranker.
create table sawk.feed (
  user_id    uuid not null,
  event_id   text not null references sawk.events (id) on delete cascade,
  score      real not null check (score >= 0 and score <= 1),
  reason     text not null,                  -- one sentence, addressed to the person
  ranked_by  text not null,                  -- "agent:<run id>" | "fallback"
  ranked_at  timestamptz not null default now(),
  state      text not null default 'new' check (state in ('new', 'saved', 'going', 'hidden', 'went', 'skipped')),
  rating     smallint check (rating between -2 and 2),   -- after the event, Loco's scale
  updated_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
create index feed_user_score on sawk.feed (user_id, score desc);

-- Every action the person took, append-only: the history agents learn from.
create table sawk.feedback (
  id       bigint generated always as identity primary key,
  user_id  uuid not null,
  event_id text not null references sawk.events (id) on delete cascade,
  action   text not null check (action in ('save', 'going', 'hide', 'went', 'skip', 'rate', 'unsave')),
  rating   smallint check (rating between -2 and 2),
  note     text,
  via      text not null default 'web',      -- "web", "loco", "mcp:<client>"
  at       timestamptz not null default now()
);
create index feedback_user_time on sawk.feedback (user_id, at desc);

-- Personal access tokens for headless agents (a scheduled `claude -p`, Codex).
-- Only the SHA-256 of the token is stored; `prefix` is its first 12 characters
-- so a person can tell tokens apart.
create table sawk.tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  name         text not null,
  hash         text not null unique,
  prefix       text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index tokens_user on sawk.tokens (user_id);

alter table sawk.profiles enable row level security;
alter table sawk.windows  enable row level security;
alter table sawk.sources  enable row level security;
alter table sawk.events   enable row level security;
alter table sawk.runs     enable row level security;
alter table sawk.feed     enable row level security;
alter table sawk.feedback enable row level security;
alter table sawk.tokens   enable row level security;
alter table sawk.migrations enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema sawk from anon';
    execute 'revoke all on all tables in schema sawk from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema sawk from authenticated';
    execute 'revoke all on all tables in schema sawk from authenticated';
  end if;
end $$;
