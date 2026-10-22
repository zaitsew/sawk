# Decisions

One entry per decision somebody will otherwise re-open.

## 2026-10-23 — SAWk lives in its own schema inside Loco's Supabase project

**Context.** SAWk is its own open-source product, and Loco uses it natively. The owner left the backend to
the agent ("decide yourself"). Agents (Claude, ChatGPT, Grok, Codex) must connect as the person, and Loco
must read the feed as the same person.

**Decision.** Schema `sawk` in Loco's project (`ltdiybajsogaydzooiwz`), with its own functions (`sawk`,
`sawk-ingest`) and its own migration ledger (`sawk.migrations`, `scripts/migrate.ts`). It never writes a
Loco table; it reads Loco through `sawk.loco_*()` functions that return empty without Loco.

**Why.** One sign-in: a Loco session is a SAWk session, and Loco's OAuth 2.1 server (dynamic client
registration, consent page) already lets Claude, ChatGPT and Grok connect, so SAWk accepts the same
tokens instead of building a second OAuth server. $0, and the org's free tier already holds two active
projects. A separate project would need its own sign-in, OAuth and server-to-server calls from Loco.
The schema boundary keeps a later move to its own project to a dump and restore.

**Cost of it.** Loco's consent page names Loco, not SAWk, when an agent connects. Both repos deploy into
one project, so SAWk must never use `supabase db push` (that ledger is Loco's).

**Status.** Accepted.

## 2026-10-23 — Agents rank; the server never calls a model

**Context.** "the scheduled runs performed, collected and prioritized the events depending on my profile
and history" — through Codex, Claude Code, ChatGPT and Grok.

**Decision.** The server stores and serves. Scheduled agent runs (on the person's own subscriptions)
search, extract and rank, writing through MCP. The server's own ingest reads machine-readable sources
(ICS, schema.org JSON-LD, Ticketmaster) and writes a rule-based fallback rank so the feed is never empty.

**Why.** No metered model spend, no API key to manage, and the person picks the agent. Every agent gets
the same context (`sawk_context`) so the ranking is comparable across them.

**Status.** Accepted.
