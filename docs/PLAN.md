# Plan

Sources: `docs/BRIEF.md`. Each phase quotes the sentence it serves.

## Phase 1 — the feed exists and agents fill it (this sprint)

> "analyze for me offline events in the city i live and travel, and will make a personal recommendations feed"
> "the scheduled runs performed, collected and prioritized the events depending on my profile and history"

| lane | branch | files | done when |
|---|---|---|---|
| A · server | `server` | `supabase/functions/sawk/**` | MCP + REST from ARCHITECTURE.md, both auth kinds, tests on PGlite |
| B · ingest | `ingest` | `supabase/functions/sawk-ingest/**`, `_shared/ingest/**`, `_shared/score.ts`, `db/migrations/0003_*.sql` | ICS, JSON-LD, Ticketmaster adapters; Valencia sources seeded; fallback rank; daily cron |
| C · web | `web` | `web/**` | PWA: sign in, feed by day and city, save/going/hide/rate, profile, agent tokens |
| D · agents | `agents` | `skills/**`, `prompts/**`, `scripts/install-*.sh`, `docs/AGENTS.md` | one procedure for Claude Code, Codex, ChatGPT and Grok; a nightly run on the Mac |
| E · Loco adapter | `loco-adapter` | `db/migrations/0002_loco.sql`, its test | windows, busy days and taste from Loco trips; empty without Loco |

Then: deploy to Loco's project, seed the owner's profile from Loco, first scheduled run, read the feed.

## Phase 2 — Loco shows it natively

> "Loco will natively use it"

A "What's on" section in Loco iOS for the city of each day (Loco repo, own PR), feedback written back
through `/api/feedback`. Loco's hosted MCP links to SAWk's.

## Phase 3 — every chat, and learning from history

> "deeply integrated on ai harnesses (codex, claude code in claude macos, etc.) and ai bots (like grok bot, chatgpt dots, etc.)"

Connector set-up for ChatGPT and Grok through Loco's OAuth server, tested end to end; ratings after the
event ("went" → rate) feeding the next run; per-city source discovery that agents propose and the person keeps.
