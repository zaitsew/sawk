import type { Action, FeedItem, Profile, Window } from "../types";
import { applyFeedback, reconcile } from "./store";

// The last good answer, so the feed still opens offline. Per-viewer convenience only:
// every access is guarded, and the app works without it.
const KEY = "sawk.feed.v1";

export interface Snapshot {
  savedAt: number;
  userId: string;
  items: FeedItem[];
  windows: Window[];
  profile: Profile | null;
}

export function loadSnapshot(userId: string): Snapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Snapshot;
    return s.userId === userId ? s : null;
  } catch { return null; }
}

export function saveSnapshot(s: Snapshot): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage may be blocked or full */ }
}

export function clearSnapshot(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Rewrite the saved answer in place. `savedAt` stays: it says when the feed was fetched. */
function updateSnapshot(userId: string, fn: (s: Snapshot) => Snapshot): void {
  const s = loadSnapshot(userId);
  if (s) saveSnapshot(fn(s));
}

/** After the server accepted a feedback action, so reopening offline shows it. Uses the
 *  server's row when it sent one, else the same optimistic change the screen already shows. */
export function recordFeedback(userId: string, eventId: string, action: Action, rating: number | undefined, row: FeedItem | null): void {
  updateSnapshot(userId, (s) => ({
    ...s,
    items: row ? reconcile(s.items, row) : applyFeedback(s.items, eventId, action, rating),
  }));
}

/** After a profile save. */
export function recordProfile(userId: string, profile: Profile): void {
  updateSnapshot(userId, (s) => ({ ...s, profile }));
}
