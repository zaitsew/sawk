import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Action, FeedItem, Profile, Window } from "../types";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";
import { loadSnapshot, recordFeedback, recordProfile, saveSnapshot } from "./cache";
import { addDays, dayKey, viewerTz } from "./days";
import { applyFeedback, reconcile } from "./store";
import { useToast } from "./toast";

export type LoadState = "loading" | "ready" | "error";

interface DataValue {
  items: FeedItem[];
  windows: Window[];
  profile: Profile | null;
  load: LoadState;
  error: string | null;
  /** Set when the profile call failed on the last refresh; `profile` is then null or stale. */
  profileError: string | null;
  refreshing: boolean;
  /** Set when what is on screen is the last saved answer, not a fresh one. */
  staleSince: number | null;
  refresh: () => Promise<void>;
  act: (eventId: string, action: Action, rating?: number) => Promise<boolean>;
  setProfile: (p: Profile) => void;
}

const Ctx = createContext<DataValue | null>(null);
export function useData(): DataValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData outside DataProvider");
  return v;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [windows, setWindows] = useState<Window[]>([]);
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!userId || inflight.current) return;
    inflight.current = true;
    setRefreshing(true);
    const today = dayKey(Date.now(), viewerTz());
    try {
      const [feed, wins, prof] = await Promise.allSettled([
        api.feed({ from: addDays(today, -7), to: addDays(today, 30), limit: 200 }),
        api.windows(35),
        api.profile(),
      ]);
      if (feed.status === "rejected") throw feed.reason;
      setItems(feed.value);
      if (wins.status === "fulfilled") setWindows(wins.value);
      if (prof.status === "fulfilled") {
        setProfileState(prof.value);
        setProfileError(null);
      } else {
        setProfileError(prof.reason instanceof ApiError ? prof.reason.message : "Could not load your profile. Try again.");
      }
      setLoad("ready");
      setError(null);
      setStaleSince(null);
      saveSnapshot({
        savedAt: Date.now(), userId, items: feed.value,
        windows: wins.status === "fulfilled" ? wins.value : [],
        // A failed profile call must not wipe the last good one from the saved answer.
        profile: prof.status === "fulfilled" ? prof.value : loadSnapshot(userId)?.profile ?? null,
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not load your feed. Try again.";
      setError(msg);
      // Keep what is on screen when it still helps (STANDARD: offline is a state, not an error).
      if (itemsRef.current.length === 0) setLoad("error");
    } finally {
      inflight.current = false;
      setRefreshing(false);
    }
  }, [userId]);

  // First paint from the saved answer, then a fresh one.
  useEffect(() => {
    if (!userId) return;
    const snap = loadSnapshot(userId);
    if (snap) {
      setItems(snap.items);
      setWindows(snap.windows);
      setProfileState(snap.profile);
      setStaleSince(snap.savedAt);
      setLoad("ready");
    }
    void refresh();
  }, [userId, refresh]);

  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [refresh]);

  const act = useCallback(async (eventId: string, action: Action, rating?: number): Promise<boolean> => {
    const before = itemsRef.current.find((i) => i.event.id === eventId);
    setItems((cur) => applyFeedback(cur, eventId, action, rating));
    try {
      const row = await api.feedback(eventId, action, rating);
      if (row) setItems((cur) => reconcile(cur, row));
      if (userId) recordFeedback(userId, eventId, action, rating, row);
      return true;
    } catch (e) {
      if (before) setItems((cur) => cur.map((i) => (i.event.id === eventId ? before : i)));
      toast({ message: e instanceof ApiError ? e.message : "Could not save that. Try again.", ms: 5000 });
      return false;
    }
  }, [toast, userId]);

  const setProfile = useCallback((p: Profile) => {
    setProfileState(p);
    setProfileError(null);
    if (userId) recordProfile(userId, p);
  }, [userId]);

  const value = useMemo<DataValue>(() => ({
    items, windows, profile, load, error, profileError, refreshing, staleSince, refresh, act, setProfile,
  }), [items, windows, profile, load, error, profileError, refreshing, staleSince, refresh, act, setProfile]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
