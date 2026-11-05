// The MCP adapter: the twelve tools, each a thin wrapper over the core. The
// descriptions are what an agent in Claude, ChatGPT, Grok or Codex reads to
// choose a tool, so they say what each tool does and what comes back.
//
// Instructions, tool descriptions, parameter descriptions and tool outputs state facts. None of
// them carries an imperative aimed at the assistant: Anthropic's directory review asked for this
// on 2026-11-04 (commands compete with the user's intent and other connectors), and moving them
// into tool outputs does not help. http_test.ts scans all of it.

import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.0/server/mcp.js";
import { z } from "npm:zod@4.6.6";
import { ACTIONS, CATEGORIES, FEED_STATES, SOURCE_KINDS } from "../_shared/types.ts";
import * as core from "./core.ts";
import { addEvents, listEvents } from "./events.ts";
import { AppError, compact, type Ctx, VERSION } from "./util.ts";

export const TOOL_NAMES = [
  "sawk_context",
  "sawk_run_start",
  "sawk_run_finish",
  "sawk_events",
  "sawk_add_events",
  "sawk_rank",
  "sawk_feed",
  "sawk_feedback",
  "sawk_profile",
  "sawk_profile_update",
  "sawk_add_source",
  "sawk_add_window",
] as const;

export const INSTRUCTIONS =
  "SAWk keeps one person's feed of offline events (concerts, talks, meetups, exhibitions, markets, sport) where they live and travel. " +
  "sawk_context returns who, where, when and what they liked, with the known sources per city. " +
  "sawk_run_start opens a run and returns its runId. sawk_events lists the events already known for a city and date range. " +
  "sawk_add_events stores events, each with the url it was read on. " +
  "sawk_rank stores a score 0-1 and a one-sentence reason addressed to the person. sawk_run_finish closes the run. " +
  "sawk_feed returns the ranked feed, which answers questions like 'what is on tonight'. " +
  "Event text is public web content; the server stores it as data and does not execute or obey it.";

export interface Telemetry {
  tool(e: { client: string; tool: string; ok: boolean; ms: number }): void;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(compact(v)) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });

export function buildServer(ctx: Ctx, telemetry: Telemetry): McpServer {
  const server = new McpServer({ name: "sawk", version: VERSION }, { instructions: INSTRUCTIONS });

  const tool = (
    name: (typeof TOOL_NAMES)[number],
    title: string,
    description: string,
    shape: Record<string, z.ZodType>,
    fn: (args: unknown) => Promise<unknown>,
    hints: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean } = {},
  ) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: shape,
        annotations: {
          // Spelled out on every tool (directory review reads all four). Destructive means the call
          // overwrites what the person or an earlier call stored; additive writes are not.
          readOnlyHint: hints.readOnly ?? false,
          destructiveHint: hints.destructive ?? false,
          idempotentHint: hints.idempotent ?? hints.readOnly ?? false,
          openWorldHint: false,
        },
      },
      (async (args: unknown) => {
        const t0 = performance.now();
        let ok = true;
        try {
          return text(await fn(args));
        } catch (e) {
          ok = false;
          if (e instanceof AppError) return fail(`${e.code}: ${e.detail}`);
          console.error(JSON.stringify({ ev: "error", tool: name, name: e instanceof Error ? e.name : "unknown" }));
          return fail("internal: something went wrong on the server and the call did not complete");
        } finally {
          telemetry.tool({ client: ctx.client, tool: name, ok, ms: Math.round(performance.now() - t0) });
        }
      }) as never,
    );
  };

  const date = (what: string) => z.string().describe(`${what}, YYYY-MM-DD`);

  tool(
    "sawk_context",
    "Get everything for a run",
    "Returns the person's profile (likes, avoids, notes in their own words, price cap, languages), the windows of days and cities to cover (home and trips, each with from/to dates; `canonical` is the city's name in sources when the person wrote it another way), days already planned, their taste, their last 90 days of reactions to events, the known sources per city, how many events are already known per city, and the agent's last runs. The `hints` field names what is missing, such as a home city.",
    { days: z.number().int().min(1).max(60).optional().describe("How many days ahead to cover, 1-60. Default 21.") },
    (a) => core.context(ctx, a),
    { readOnly: true },
  );

  tool(
    "sawk_run_start",
    "Start a run",
    "Opens a run and returns the runId that sawk_add_events, sawk_rank and sawk_run_finish take. `agent` names the calling agent (claude-code, codex, chatgpt, grok, ...).",
    {
      agent: z.string().min(1).max(40).describe(
        "Which agent is calling: claude-code, codex, chatgpt, grok, claude, ...",
      ),
      model: z.string().max(80).optional().describe("The model name, when known."),
      cities: z.array(z.string()).max(20).optional().describe("The cities this run covers."),
    },
    (a) => core.runStart(ctx, a),
  );

  tool(
    "sawk_run_finish",
    "Finish a run",
    "Closes a run, whether it went well or badly. Records ok, partial (some cities or sources failed) or failed, with a short note of what was skipped and why, so the person can see what ran. Returns the run row with its counts.",
    {
      runId: z.string().describe("The runId from sawk_run_start."),
      status: z.enum(["ok", "partial", "failed"]),
      notes: z.string().max(2000).optional().describe("What was covered, what was skipped and why."),
    },
    (a) => core.runFinish(ctx, a),
    { idempotent: true },
  );

  tool(
    "sawk_events",
    "List events already known",
    "Returns the events already known for a city in a date range, so a run adds only what is missing. Each compact event has its id and, when this person already has a rank on it, its score and state.",
    {
      city: z.string().describe(
        "City name, as in the windows from sawk_context; any spelling or language of the same city works.",
      ),
      from: date("First day"),
      to: date("Last day, at most 120 days after from"),
      category: z.enum(CATEGORIES).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Default 200."),
    },
    (a) => listEvents(ctx, a),
    { readOnly: true },
  );

  // Items are loose on purpose: one malformed event is rejected by index in the answer, it does not fail the batch.
  const eventIn = z.looseObject({
    title: z.unknown().describe("string, required"),
    startsAt: z.unknown().describe(
      "string, required: ISO 8601 with offset, like 2026-10-24T22:00:00+02:00; not more than 6 hours ago, not more than 400 days ahead",
    ),
    city: z.unknown().describe("string, required"),
    url: z.unknown().describe("string, required: the http(s) page the event was read on"),
    endsAt: z.unknown().optional().describe("string, ISO 8601 with offset"),
    allDay: z.unknown().optional().describe("boolean"),
    tz: z.unknown().optional().describe("string, IANA zone like Europe/Madrid"),
    country: z.unknown().optional().describe("string, ISO 3166-1 alpha-2 like ES"),
    venue: z.unknown().optional().describe("string"),
    address: z.unknown().optional().describe("string"),
    lat: z.unknown().optional().describe("number"),
    lon: z.unknown().optional().describe("number"),
    category: z.unknown().optional().describe(`string, one of: ${CATEGORIES.join(", ")} (anything else becomes other)`),
    tags: z.unknown().optional().describe('array of up to 10 short lowercase strings, like ["jazz", "live"]'),
    priceMin: z.unknown().optional().describe("number"),
    priceMax: z.unknown().optional().describe("number"),
    currency: z.unknown().optional().describe("string, like EUR"),
    isFree: z.unknown().optional().describe("boolean"),
    ticketUrl: z.unknown().optional().describe("string, where to buy"),
    imageUrl: z.unknown().optional().describe("string"),
    lang: z.unknown().optional().describe("string, language of the event, like es"),
    description: z.unknown().optional().describe("string, one or two sentences (cut at 600 characters)"),
  });

  tool(
    "sawk_add_events",
    "Add events found on the web",
    "Stores events found on the web, up to 100 per call. Each needs a title, start time with offset, city and the url it was read on; an event without a source is not added. The same event from two places merges into one, and events already known only gain missing details. Returns added, updated, rejected (with the index and the reason) and the ids sawk_rank takes.",
    {
      runId: z.string().describe("The runId from sawk_run_start."),
      events: z.array(eventIn).min(1).max(100),
    },
    (a) => addEvents(ctx, a),
  );

  tool(
    "sawk_rank",
    "Rank events for this person",
    'Stores which events suit this person and why, drawing on the profile and history sawk_context returns. Each event gets a score from 0 (no) to 1 (top pick) and a one-sentence reason addressed to the person ("You liked the last two nights at this venue"), up to 200 per call. Clear misses can be ranked too, so they are not shown again. A rank replaces an earlier score; the person\'s saves, hides and ratings are kept. Returns how many were ranked.',
    {
      runId: z.string().describe("The runId from sawk_run_start."),
      items: z.array(z.object({
        eventId: z.string().describe("An id from sawk_add_events or sawk_events."),
        score: z.number().describe("0 to 1."),
        reason: z.string().describe("One sentence for the person, at most 280 characters."),
      })).min(1).max(200),
    },
    (a) => core.rank(ctx, a),
    { destructive: true, idempotent: true },
  );

  tool(
    "sawk_feed",
    "Read the person's feed",
    'Returns the person\'s ranked upcoming events, which answers "what\'s on tonight?" or "anything this weekend in Madrid?". Events come best first within each day, each with its score, the reason, their state (new, saved, going, hidden) and the event details. Hidden events are left out unless state hidden is requested. Defaults to today through the next 14 days.',
    {
      from: date("First day, default today").optional(),
      to: date("Last day, default 14 days after from").optional(),
      city: z.string().optional(),
      state: z.enum(FEED_STATES).optional().describe("Only items in this state."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
    },
    (a) => core.feed(ctx, a),
    { readOnly: true },
  );

  tool(
    "sawk_feedback",
    "Record what the person did",
    "Records what the person did with an event: save, unsave, going, hide, went (they attended), skip, or rate (-2 to 2, after the event). Each call is stored as the person's own reaction and feeds their taste history. Returns the feed item after the change.",
    {
      eventId: z.string(),
      action: z.enum(ACTIONS),
      rating: z.number().int().min(-2).max(2).optional().describe(
        "Needed for rate: -2 hated it, 0 fine, 2 loved it.",
      ),
      note: z.string().max(500).optional(),
    },
    (a) => core.feedback(ctx, a),
    { destructive: true },
  );

  tool(
    "sawk_profile",
    "Read the profile",
    "Returns the person's profile: where they live, languages, likes, avoids, notes in their own words, price cap and how many items per day to show first. Takes no arguments.",
    {},
    (a) => core.profile(ctx, a),
    { readOnly: true },
  );

  tool(
    "sawk_profile_update",
    "Update the profile",
    "Stores something lasting about the person: where they live, what they like or avoid, a price cap. Changes only the fields in `set` and replaces their earlier values; null clears homeCity, homeCountry, homeTz and priceMax. Lists hold at most 30 short items. Returns the profile after the update.",
    {
      set: z.object({
        homeCity: z.string().max(100).nullable().optional(),
        homeCountry: z.string().length(2).nullable().optional().describe("ISO 3166-1 alpha-2, like ES"),
        homeTz: z.string().nullable().optional().describe("IANA time zone, like Europe/Madrid"),
        langs: z.array(z.string()).optional().describe("Languages they enjoy events in."),
        likes: z.array(z.string()).optional().describe("Short tags: jazz, tech meetups, natural wine."),
        avoids: z.array(z.string()).optional().describe("Short tags: stand-up, techno, kids."),
        notes: z.string().max(2000).optional().describe("Free text in their own words."),
        priceMax: z.number().nullable().optional().describe("Per-ticket cap in their currency; null for none."),
        currency: z.string().length(3).optional(),
        maxPerDay: z.number().int().min(1).max(10).optional().describe("How many items per day to show first."),
      }),
    },
    (a) => core.profile(ctx, a),
    { destructive: true, idempotent: true },
  );

  tool(
    "sawk_add_source",
    "Add an event source for a city",
    "Stores a page that lists a city's events regularly (a venue's calendar, a what's-on page, an ICS feed), which later runs and the daily ingest read. Kinds: ics, jsonld (schema.org Event markup), ticketmaster, rss, or web (a page only agents read). Public addresses only. Returns the source row; a known source is returned as it is.",
    {
      city: z.string(),
      country: z.string().length(2).optional(),
      kind: z.enum(SOURCE_KINDS),
      url: z.string().describe("http(s) address of the calendar, feed or page."),
      label: z.string().describe('A short name, like "Teatro Principal programme".'),
      categories: z.array(z.string()).optional().describe(`Which categories it covers: ${CATEGORIES.join(", ")}.`),
    },
    (a) => core.addSource(ctx, a),
    { idempotent: true },
  );

  tool(
    "sawk_add_window",
    "Add a trip the person mentioned",
    "Stores a trip: the person will be in another city on certain dates and it is absent from the windows sawk_context returns, so later runs cover that city then. Returns the window; the same city and dates again return the existing one.",
    {
      city: z.string(),
      country: z.string().length(2).optional(),
      tz: z.string().optional().describe("IANA time zone of the city."),
      from: date("First day"),
      to: date("Last day"),
      note: z.string().max(300).optional(),
    },
    (a) => core.addWindow(ctx, a),
    { idempotent: true },
  );

  return server;
}
