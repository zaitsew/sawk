# SAWk — agent guide

One line: SAWk is a personal feed of offline events where you live and travel, filled and ranked by scheduled
AI agents through its MCP server. Open source; the owner's deployment shares Loco's Supabase project.

Read first: `docs/BRIEF.md` (the owner's words), `docs/ARCHITECTURE.md` (the contract), `docs/PLAN.md`,
`docs/DECISIONS.md`.

## Hard rules

- Everything lives in schema `sawk`. Never create, alter or write a table outside it; Loco's tables are read
  only, through `sawk.loco_*()` functions.
- Never run `supabase db push` or `supabase migration` here: that ledger belongs to Loco. Migrations go
  through `deno task migrate` (ledger `sawk.migrations`).
- The server never calls a model. Agents rank; `sawk-ingest` reads machine-readable sources only.
- Every event carries the `url` it was read from. An event without a source is rejected.
- This repo is public: no tokens, no project secrets, no personal data in fixtures or docs.

## How to run / check it

```
./check.sh            # tests (Deno + PGlite, no Docker), web build, what is missing
deno task test        # server tests only
```

## Conventions

- **Skills** are procedures: `skills/<name>/SKILL.md` (shipped to users) and `.claude/skills/` (for this repo).
  **Rules** are constraints from real corrections: `.claude/rules/`. **Facts** go in `docs/`.
- Shipping: open the PR and stop unless this repo is named on the merge-approved list in `~/.claude/CLAUDE.md`.
  One PR per logical unit, `gh pr merge --merge`, never squash, never force-push.

Shared session policy for every harness: `~/.agents/POLICY.md`.
