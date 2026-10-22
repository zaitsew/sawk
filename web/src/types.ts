// Wire shapes, copied from supabase/functions/_shared/types.ts (docs/ARCHITECTURE.md is the prose).
// Copied, not imported: web/ builds on its own. Keep in step by hand.

export const CATEGORIES = [
  "music", "nightlife", "art", "theatre", "film", "talk", "meetup", "tech",
  "food", "sport", "market", "festival", "family", "outdoor", "other",
] as const;
export type Category = typeof CATEGORIES[number];

export type FeedState = "new" | "saved" | "going" | "hidden" | "went" | "skipped";
export type Action = "save" | "unsave" | "going" | "hide" | "went" | "skip" | "rate";

export interface Profile {
  homeCity: string | null;
  homeCountry: string | null;
  homeTz: string | null;
  langs: string[];
  likes: string[];
  avoids: string[];
  notes: string;
  priceMax: number | null;
  currency: string;
  maxPerDay: number;
  updatedAt?: string;
}

/** A stretch of days in one city: home, a Loco trip stay, or a manual window. */
export interface Window {
  city: string;
  country: string | null;
  tz: string | null;
  from: string; // YYYY-MM-DD, inclusive
  to: string;   // YYYY-MM-DD, inclusive
  source: "home" | "loco" | "manual";
  id?: string;
  note?: string | null;
}

export interface Event {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  tz: string | null;
  city: string;
  country: string | null;
  venue: string | null;
  address: string | null;
  category: Category;
  tags: string[];
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  isFree: boolean | null;
  url: string;
  ticketUrl: string | null;
  imageUrl: string | null;
  lang: string | null;
  description: string | null;
  cancelled: boolean;
}

export interface FeedItem {
  event: Event;
  score: number;
  reason: string;
  rankedBy: string;
  rankedAt: string;
  state: FeedState;
  rating: number | null;
}

// --- shapes the contract leaves open (see the PR's "contract questions") -----------------------

/** One row of GET /api/runs (columns of sawk.runs, camelCased). */
export interface Run {
  id: string;
  agent: string;
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "partial" | "failed";
  cities: string[];
  eventsAdded: number;
  ranked: number;
  notes: string | null;
}

/** One row of GET /api/tokens (never the hash, never the token). */
export interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** POST /api/tokens: the row plus the secret, once. */
export interface TokenCreated extends TokenRow {
  token: string;
}
