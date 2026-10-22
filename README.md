# SAWk

**For the socially awkward: what's on, offline, where you'll be — picked for you.**

SAWk keeps a personal feed of offline events (concerts, talks, meetups, exhibitions, markets, sport) in the
city you live in and the cities you travel to. Your AI agents do the legwork on a schedule — Claude Code,
Codex, ChatGPT, Grok — reading your profile and history through SAWk's MCP server, searching the web, and
writing back events with a one-line reason each. You read the feed on the web, in [Loco](https://loco.fabriquefutur.com),
or by asking any connected chat "what's on tonight?".

## Quick start

```
git clone https://github.com/zaitsew/sawk && cd sawk
cp .env.example .env          # SUPABASE_URL, DATABASE_URL (+ optional TICKETMASTER_API_KEY)
deno task migrate             # creates schema `sawk` in your Supabase project
supabase functions deploy sawk sawk-ingest --no-verify-jwt
./check.sh                    # tests and what is still missing
```

Then connect an agent: `docs/AGENTS.md`.

## How it works

- **Agents rank, the server stores.** No model is called server-side; scheduled runs use your own subscriptions.
- **One context for every agent.** `sawk_context` returns your profile, where you'll be (home and trips), your
  busy days, your taste and your history, so Claude and ChatGPT rank by the same facts.
- **A floor without agents.** A daily ingest reads machine-readable sources (ICS, schema.org JSON-LD,
  Ticketmaster) and ranks by your tags, so the feed is never empty.
- **Self-hostable.** Everything lives in schema `sawk` of any Supabase project. Loco integration turns on by
  itself when Loco's tables are present.

Details: `docs/ARCHITECTURE.md`. Why it is built this way: `docs/DECISIONS.md`.

## Status

Alpha, one user. Built in public.

## Licence

Apache-2.0. See `LICENSE`.
