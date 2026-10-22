import { icsAdapter } from "./ics.ts";
import { jsonldAdapter } from "./jsonld.ts";
import { ticketmasterAdapter } from "./ticketmaster.ts";
import type { Adapter } from "./types.ts";

/** Kinds the server reads itself. `rss` and `web` are read by agents only. */
export const ADAPTERS: Record<string, Adapter> = {
  ics: icsAdapter,
  jsonld: jsonldAdapter,
  ticketmaster: ticketmasterAdapter,
};

export const MACHINE_KINDS = Object.keys(ADAPTERS);
