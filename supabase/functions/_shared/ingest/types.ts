// What an adapter gets and returns. Adapters never throw: a failure is `error`
// next to whatever events were read before it.

import type { EventIn, SourceKind } from "../types.ts";

export type Fetch = typeof fetch;

/** The columns of sawk.sources an adapter needs. */
export interface SourceRow {
  id: string;
  city: string;
  country: string | null;
  kind: SourceKind;
  url: string;
  label: string;
  categories: string[];
}

/** An event as an adapter reads it. `cancelled` is not part of the agent-facing EventIn. */
export interface IngestEvent extends EventIn {
  cancelled?: boolean;
}

export interface AdapterResult {
  events: IngestEvent[];
  error?: string;
}

export interface AdapterCtx {
  fetch: Fetch;
  now: Date;
  env: (name: string) => string | undefined;
  /** Sleep, replaceable in tests (rate limiting). */
  sleep?: (ms: number) => Promise<void>;
  /** Shared by every source of one run (robots.txt answers). */
  cache?: Map<string, unknown>;
}

export type Adapter = (source: SourceRow, ctx: AdapterCtx) => Promise<AdapterResult>;
