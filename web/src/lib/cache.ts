import type { FeedItem, Profile, Window } from "../types";

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
