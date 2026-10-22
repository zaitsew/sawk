import type { Event, FeedItem } from "../types";

/** A feed item for tests. */
export function fx(over: Partial<Event> & { score?: number; state?: FeedItem["state"]; rating?: number | null; reason?: string } = {}): FeedItem {
  const { score = 0.5, state = "new", rating = null, reason = "Because.", ...e } = over;
  return {
    event: {
      id: e.id ?? "e1", title: "Jazz", startsAt: "2026-10-24T20:00:00+02:00", endsAt: null, allDay: false,
      tz: "Europe/Madrid", city: "Valencia", country: "ES", venue: null, address: null, category: "music",
      tags: [], priceMin: null, priceMax: null, currency: "EUR", isFree: null, url: "https://example.com",
      ticketUrl: null, imageUrl: null, lang: null, description: null, cancelled: false, ...e,
    },
    score, reason, rankedBy: "agent:test", rankedAt: "2026-10-23T00:00:00Z", state, rating,
  };
}
