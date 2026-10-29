# Connect an agent to SAWk

SAWk exposes one MCP server. Any client below can read your context from it, add events it found, and
rank them for you. The procedure every client follows is `skills/sawk/SKILL.md` (Claude Code, Codex)
or `prompts/scheduled-run.md` (ChatGPT, Grok). The tools are listed in `docs/ARCHITECTURE.md`.

```
MCP URL   <SUPABASE_URL>/functions/v1/sawk/mcp            (Streamable HTTP)
Auth      OAuth with your Loco account, or a personal token  sawk_pat_...  (web app > Agents)
```

Checked on 2026-10-23. Vendors change menus often; the doc link in each section is the source.
"Not verified" marks a step nobody has run against a deployed SAWk yet.

## Which client should run the nightly job

One is enough. Two nightly runs cost two subscriptions' limits and write the same feed twice.

| client | runs unattended | needs the Mac awake | cost to you | verdict |
|---|---|---|---|---|
| **Claude Code** (`scripts/install-claude.sh`) | yes, launchd 05:15 | yes (runs on wake if it slept) | your Claude subscription | **recommended**: full web access, the skill, 45-minute budget, logs on disk |
| Codex CLI (`install-codex.sh --nightly`) | yes, launchd | yes | your ChatGPT/Codex plan | works the same; pick it if Codex is your main tool |
| ChatGPT scheduled task | yes, in the cloud | no | your ChatGPT plan | **cloud alternative** when the Mac sleeps or is off. At most one run an hour; connector use in tasks not verified against OpenAI's docs |
| Grok automation | yes, in the cloud | no | your Grok plan | not recommended: custom connectors in automations are unconfirmed (below) |

Use the others for questions ("what's on tonight?"), not for the nightly fill.

## Claude Code (terminal and the Mac app's Code tab)

Docs: https://code.claude.com/docs/en/mcp

1. Create a token in the web app: Agents > New token. Copy it once.
2. Run `SAWK_TOKEN=<token> scripts/install-claude.sh --dry-run` and read the plan.
3. Run it without `--dry-run`. It stores the token in the macOS Keychain, registers the MCP server `sawk`
   (user scope), links the skill into `~/.claude/skills/sawk`, and loads the launchd job.
4. Check: `claude mcp list` shows `sawk`; in a Claude Code session ask "what's on tonight?".
5. First fill now: `scripts/run-nightly.sh`. After that it runs at 05:15; the log is
   `~/Library/Logs/sawk-nightly.log`.
6. Remove everything: `scripts/install-claude.sh --uninstall`.

How it works: the installer registers the server with `claude mcp add-json` and a `headersHelper`
(a 3-line script that prints the Authorization header from Keychain; supported by Claude Code for HTTP
servers). `~/.claude.json` therefore holds no token. If your Claude Code is older, use
`--store-token-in-config`, which runs `claude mcp add --transport http --scope user sawk <url> --header ...`
and writes the token into `~/.claude.json`.

The nightly run uses `claude -p ... --model sonnet --allowedTools "mcp__sawk__*,WebSearch,WebFetch,Skill"
--max-turns 80`, under `gtimeout` for 45 minutes, and skips the night when `teyla load` says the
machine is overloaded. It unsets `ANTHROPIC_API_KEY`, so the run bills your subscription.

## Claude Code plugin (skill and MCP server in one step)

An alternative to `scripts/install-claude.sh` when you only want to ask questions, or run the skill by hand. The
plugin bundles `skills/sawk` and an `.mcp.json` pointing at `${SAWK_URL}/mcp`; sign in with OAuth (Loco account)
the first time (`/mcp` in Claude Code). It does not store a token or schedule the nightly run.

```
export SAWK_URL=https://<ref>.supabase.co/functions/v1/sawk
claude plugin marketplace add zaitsew/sawk
claude plugin install sawk@sawk
```

Set `SAWK_URL` in the environment that starts Claude Code. Tools appear as `mcp__plugin_sawk_sawk__sawk_*`.
The plugin is for the owner and self-hosters: SAWk is single-owner, so it is not listed in a public directory.

## Claude desktop app and claude.ai (chat)

Docs: https://support.claude.com/en/articles/11175166

Claude Desktop and claude.ai use one account-level connector list. Remote servers are not added in
`claude_desktop_config.json`.

1. Customize > Connectors > + Add > Add custom connector.
2. Name: `SAWk`. URL: the MCP URL above. Continue.
3. Authentication, either:
   - **Sign in now** (OAuth): sign in with your Loco account when asked. The SAWk server publishes the OAuth
     metadata (`/.well-known/oauth-protected-resource`, checked against the deployed function on 2026-10-29).
   - **No sign in** plus **Request headers**: add `Authorization: Bearer sawk_pat_...`. Works without OAuth.
4. Add. In a chat press **+** > Connectors and switch SAWk on for the conversation.
5. Ask "what's on this weekend?". The chat answers from the feed (Ask mode,
   `prompts/ask.md` makes a good project instruction).

The connector connects from Anthropic's cloud, so the SAWk URL must be public (it is: a Supabase
function). The skill is not needed in chat; paste `prompts/ask.md` into a Project instead.

## Codex (CLI, IDE extension and the Codex app)

Docs: https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli (MCP) and
https://learn.chatgpt.com/docs/build-skills.md (skills). The pages moved from developers.openai.com/codex.

1. Make sure a token is in the Keychain (`scripts/install-claude.sh`), or pass `SAWK_TOKEN=...`.
2. `scripts/install-codex.sh --dry-run`, then without the flag.
3. It runs `codex mcp add sawk --url <MCP URL>` and adds `http_headers_helper` (a command Codex runs to
   get headers; same Keychain helper as above) to `~/.codex/config.toml`. CLI, IDE extension and the app
   share that file, so the app needs no environment variable.
4. It links the skill into `~/.agents/skills/sawk`: Codex's user skills directory is `$HOME/.agents/skills`
   (symlinks are followed). `~/.codex/skills` is not scanned.
5. Check: `codex mcp get sawk`; then `codex exec --skip-git-repo-check "Use the sawk skill in Ask mode:
   what's on tonight?"`.
6. Optional nightly: `scripts/install-codex.sh --nightly` (uses `codex exec`, read-only sandbox, live web
   search, and approves sawk's tools for that run only). It replaces the Claude Code job; do not run both.
7. Remove: `scripts/install-codex.sh --uninstall`.

Alternative without a helper: `bearer_token_env_var = "SAWK_TOKEN"` in the server's table; then the
variable must exist in the environment that starts Codex (not true for an app opened from the Dock).
Not verified: `codex exec` with `web_search="live"` against a deployed SAWk.

## ChatGPT (chat, Pulse and scheduled tasks)

Docs: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt and
https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt. Both pages answered HTTP 403 to
the tool used for this guide, so the steps below come from secondary guides (linked) and are **not verified**
against OpenAI's pages.

1. Settings > Apps (Connectors) > Advanced > turn on **Developer mode**. It needs a paid plan; which plans
   get write actions differs between sources (https://docs.dataddo.com/docs/chatgpt.md,
   https://help.boomi.com/docs/Atomsphere/Platform/Connect_chatgpt_setup).
2. Create a custom connector: name `SAWk`, URL = the MCP URL, authentication **OAuth**. ChatGPT custom
   connectors support OAuth or no authentication, not a static bearer header, so a personal token does not
   work here. OAuth goes through Loco's Supabase Auth server; SAWk publishes the metadata that points to it.
3. Sign in with your Loco account when asked. Tick SAWk's tools as allowed.
4. Ask "what's on tonight?" with the connector enabled in the chat. Put `prompts/ask.md` in a Project.
5. Nightly alternative: create a **scheduled task** (ask ChatGPT "every day at 6am run this task", or
   Pulse > Tasks), paste `prompts/scheduled-run.md`, and enable the SAWk connector for it. Third-party
   sources say tasks use the same connector system as chats, at most once an hour
   (https://porteden.com/blog/chatgpt-scheduled-tasks-tools/). Run it once by hand and check the web app's
   Agents screen before trusting it.

Pulse (the daily digest) reads your chats and connected apps; no source says it calls custom MCP servers.
Do not rely on Pulse for the SAWk run; use a task.

## Grok (grok.com, the Grok app, the API)

Docs: https://docs.x.ai/grok/connectors, https://docs.x.ai/developers/tools/remote-mcp

What is possible today:

- **Chat with a connector: yes.** grok.com/connectors > New Connector > **Custom**, enter the MCP URL and
  complete authentication. The server must be reachable from the internet. On Business and Enterprise a
  team admin provisions it first. xAI's page does not say which authentication kinds custom connectors
  accept; try OAuth (Loco account) first.
- **Scheduled run with the connector: not confirmed.** Grok has Automations (grok.com/automations or the app;
  once, daily, weekdays, weekly, monthly), and a secondary source says a connector can be added to an
  automation with `@` (https://www.usecarly.com/blog/grok-automations/). No xAI page says whether
  *custom* connectors work inside an automation. Test it: create an automation with
  `prompts/scheduled-run.md`, press "Run now", look at the Agents screen in the SAWk web app.
- **The xAI API can do it from a script**, billed to an xAI API key, not the Grok subscription. The API's
  remote MCP tool takes `server_url`, `server_label` and `authorization`
  (https://docs.x.ai/developers/tools/remote-mcp):

  ```bash
  curl https://api.x.ai/v1/responses \
    -H "Authorization: Bearer $XAI_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n --arg p "$(sed '1,/^---$/d' prompts/scheduled-run.md)" --arg url "$SAWK_URL/mcp" --arg tok "$SAWK_TOKEN" '{
      model: "grok-4.7", input: [{role: "user", content: $p}],
      tools: [{type: "mcp", server_url: $url, server_label: "sawk", authorization: $tok},
              {type: "web_search"}]}')"
  ```

  Not verified: that the API accepts `mcp` and `web_search` in one request (the xAI pages do not say), that
  `authorization` wants the bare token or `Bearer <token>`, and the cost of a run. The Grok subscription may
  be cancelled; plan on Claude Code for the nightly run.

## Did it run?

- **Web app, Agents screen:** the last runs with agent, model, status, notes, events added.
- **API:** `curl -H "Authorization: Bearer $(security find-generic-password -s sawk -a token -w)"
  $SAWK_URL/api/runs?limit=5`.
- **Mac log:** `tail ~/Library/Logs/sawk-nightly.log`. A line `skipping tonight's run` means the machine
  was loaded; `no SAWk token` means re-run the installer.
- **Teyla:** `teyla routines` in this repo shows `nightly-agent-run`: loaded, last run, stale.
- A run still `running` after an hour was killed by the timeout; the next run starts clean.

## Safety

- The skill reads the web and writes only to your own feed. It buys nothing, sends nothing, signs in
  nowhere.
- The token lives in the Keychain, never in the repo or a config file (except with
  `--store-token-in-config`). Revoke it in the web app's Agents screen; the next run fails with 401.
- Web pages are untrusted. The skill tells the agent to treat page text as data and to skip anything
  that asks it to act.
