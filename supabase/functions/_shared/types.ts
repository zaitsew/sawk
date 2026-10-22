// The shapes on the wire. docs/ARCHITECTURE.md is the prose; this is the type.

export const CATEGORIES = [
  "music", "nightlife", "art", "theatre", "film", "talk", "meetup", "tech",
  "food", "sport", "market", "festival", "family", "outdoor", "other",
] as const;
export type Category = typeof CATEGORIES[number];

export const FEED_STATES = ["new", "saved", "going", "hidden", "went", "skipped"] as const;
export type FeedState = typeof FEED_STATES[number];

export const ACTIONS = ["save", "unsave", "going", "hide", "went", "skip", "rate"] as const;
export type Action = typeof ACTIONS[number];

export const SOURCE_KINDS = ["ics", "jsonld", "ticketmaster", "rss", "web"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

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

export interface EventIn {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  tz?: string | null;
  city: string;
  country?: string | null;
  venue?: string | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  category?: string | null;
  tags?: string[];
  priceMin?: number | null;
  priceMax?: number | null;
  currency?: string | null;
  isFree?: boolean | null;
  url: string;
  ticketUrl?: string | null;
  imageUrl?: string | null;
  lang?: string | null;
  description?: string | null;
}

export interface Event extends Required<Pick<EventIn, "title" | "startsAt" | "city" | "url">> {
  id: string;
  endsAt: string | null;
  allDay: boolean;
  tz: string | null;
  country: string | null;
  venue: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  category: Category;
  tags: string[];
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  isFree: boolean | null;
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

export interface RankIn {
  eventId: string;
  score: number;
  reason: string;
}
