import type { Action, FeedItem, FeedState } from "../types";

/** The state an action leads to. `rate` on something planned means the person went. */
export function nextState(state: FeedState, action: Action): FeedState {
  switch (action) {
    case "save": return "saved";
    case "unsave": return "new";
    case "going": return "going";
    case "hide": return "hidden";
    case "went": return "went";
    case "skip": return "skipped";
    case "rate": return state === "going" || state === "saved" ? "went" : state;
  }
}

/** Optimistic local update, applied before the server answers. */
export function applyFeedback(items: FeedItem[], eventId: string, action: Action, rating?: number): FeedItem[] {
  return items.map((it) => {
    if (it.event.id !== eventId) return it;
    const next: FeedItem = { ...it, state: nextState(it.state, action) };
    if (action === "rate" && rating !== undefined) next.rating = rating;
    return next;
  });
}

/** Swap in the server's row for an event (the server is the truth once it answers). */
export function reconcile(items: FeedItem[], row: FeedItem): FeedItem[] {
  return items.map((it) => (it.event.id === row.event.id ? row : it));
}

/** The action that puts an item back in the state it was in (for Undo). */
export function undoAction(prev: FeedState): Action {
  switch (prev) {
    case "saved": return "save";
    case "going": return "going";
    case "went": return "went";
    case "skipped": return "skip";
    default: return "unsave"; // new, and hidden itself
  }
}

export type Filter = "all" | "saved" | "going";

export function matchesFilter(it: FeedItem, f: Filter): boolean {
  if (it.state === "hidden") return false;
  if (f === "saved") return it.state === "saved";
  if (f === "going") return it.state === "going";
  return true;
}

/** Faces for the five ratings, −2 … 2. */
export const FACES: { rating: number; face: string; label: string }[] = [
  { rating: -2, face: "🤢", label: "Awful" },
  { rating: -1, face: "👎", label: "Not good" },
  { rating: 0, face: "😐", label: "Fine" },
  { rating: 1, face: "👍", label: "Good" },
  { rating: 2, face: "❤️", label: "Loved it" },
];

/** Planned, past, and not yet rated or dismissed: the "How was it?" prompt. */
export function needsRating(it: FeedItem, past: boolean): boolean {
  return past && (it.state === "going" || it.state === "saved" || it.state === "went") && it.rating == null;
}
