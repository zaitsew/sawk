import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "../components/Card";
import { cityLine, groupByDay, isPast, viewerTz, windowFor, windowKey } from "../lib/days";
import { useData } from "../lib/data";
import { matchesFilter, needsRating, undoAction, type Filter } from "../lib/store";
import { useToast } from "../lib/toast";
import type { FeedItem } from "../types";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "saved", label: "Saved" },
  { id: "going", label: "Going" },
];

/** Pull down at the top of the page to refresh. */
function usePullToRefresh(onRefresh: () => void) {
  const [pull, setPull] = useState(0);
  const start = useRef<number | null>(null);
  const pulled = useRef(0);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    const down = (e: TouchEvent) => { start.current = window.scrollY <= 0 ? e.touches[0].clientY : null; };
    const move = (e: TouchEvent) => {
      if (start.current == null) return;
      const dy = e.touches[0].clientY - start.current;
      pulled.current = dy > 0 ? Math.min(dy, 90) : 0;
      setPull(pulled.current);
    };
    const up = () => {
      if (pulled.current >= 70) cb.current();
      pulled.current = 0;
      start.current = null;
      setPull(0);
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    };
  }, []);
  return pull;
}

export function Feed({ goAgents }: { goAgents: () => void }) {
  const { items, windows, profile, load, error, refreshing, staleSince, refresh, act } = useData();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const pull = usePullToRefresh(() => void refresh());

  const fallbackTz = profile?.homeTz || viewerTz();
  const currency = profile?.currency || "EUR";
  const maxPerDay = profile?.maxPerDay ?? 3;
  const now = Date.now();

  const { upcoming, toRate } = useMemo(() => {
    const up: FeedItem[] = [];
    const rate: FeedItem[] = [];
    for (const it of items) {
      const past = isPast(it.event, now, fallbackTz);
      if (!past) { if (matchesFilter(it, filter)) up.push(it); continue; }
      if (filter === "all" && needsRating(it, true)) rate.push(it);
    }
    rate.sort((a, b) => Date.parse(b.event.startsAt) - Date.parse(a.event.startsAt));
    return { upcoming: up, toRate: rate };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter, fallbackTz]);

  const groups = useMemo(
    () => groupByDay(upcoming, { now, maxPerDay, fallbackTz }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [upcoming, maxPerDay, fallbackTz],
  );

  function hide(it: FeedItem) {
    const prev = it.state;
    void act(it.event.id, "hide").then((ok) => {
      if (!ok) return;
      toast({
        message: `Hidden: ${it.event.title}`,
        actionLabel: "Undo",
        onAction: () => void act(it.event.id, undoAction(prev)),
      });
    });
  }

  const cardFor = (it: FeedItem, past = false) => (
    <li key={it.event.id}>
      <Card
        item={it} fallbackTz={fallbackTz} currency={currency} past={past} askRating={past && needsRating(it, true)}
        onSave={() => void act(it.event.id, it.state === "saved" ? "unsave" : "save")}
        onGoing={() => void act(it.event.id, it.state === "going" ? "unsave" : "going")}
        onHide={() => hide(it)}
        onRate={(r) => void act(it.event.id, "rate", r)}
        onSkip={() => void act(it.event.id, "skip")}
      />
    </li>
  );

  let lastWindow = "";
  const empty = load === "ready" && groups.length === 0 && toRate.length === 0;

  return (
    <section aria-labelledby="feed-h">
      <div className="ptr" style={{ height: pull }} aria-hidden="true">{pull >= 70 ? "Release to refresh" : pull > 8 ? "Pull to refresh" : ""}</div>
      <header className="screen-head">
        <h1 id="feed-h" className="screen-title">Your feed</h1>
        <button type="button" className="btn btn-quiet" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh feed">
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <div className="filters" role="group" aria-label="Filter">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="chip chip-btn" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>

      {error && load === "ready" && (
        <p className="banner" role="status">
          {staleSince ? `Could not reach SAWk. Showing your feed from ${new Date(staleSince).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}.` : error}
          {" "}<button type="button" className="link" onClick={() => void refresh()}>Retry</button>
        </p>
      )}

      {load === "loading" && items.length === 0 && (
        <ul className="list" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => <li key={i}><div className="card skeleton" /></li>)}
        </ul>
      )}

      {load === "error" && (
        <div className="empty" role="alert">
          <p>{error ?? "Could not load your feed."}</p>
          <button type="button" className="btn btn-primary" onClick={() => void refresh()}>Try again</button>
        </div>
      )}

      {toRate.length > 0 && (
        <div className="day">
          <h2 className="day-title">How was it?</h2>
          <ul className="list">{toRate.map((it) => cardFor(it, true))}</ul>
        </div>
      )}

      {groups.map((g) => {
        const w = windowFor(g.day, windows);
        const wk = w ? windowKey(w) : "";
        const line = wk !== lastWindow ? cityLine(w) : null;
        lastWindow = wk;
        const expanded = open.has(g.day);
        const list = expanded ? g.all : g.shown;
        return (
          <div className="day" key={g.day}>
            {line && <p className="city-line">{line}</p>}
            <h2 className="day-title">{g.label}</h2>
            <ul className="list">{list.map((it) => cardFor(it))}</ul>
            {g.more.length > 0 && (
              <button
                type="button" className="btn btn-quiet more" aria-expanded={expanded}
                onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(g.day)) n.delete(g.day); else n.add(g.day); return n; })}
              >
                {expanded ? "Show fewer" : `${g.more.length} more`}
              </button>
            )}
          </div>
        );
      })}

      {empty && (
        <div className="empty">
          {filter === "all" ? (
            <>
              <p>Nothing here yet. Your agents fill this feed overnight.</p>
              <button type="button" className="btn btn-primary" onClick={goAgents}>Connect an agent</button>
            </>
          ) : (
            <p>{filter === "saved" ? "Nothing saved yet. Tap Save on an event to keep it here." : "Nothing planned yet. Tap Going on an event you will attend."}</p>
          )}
        </div>
      )}
    </section>
  );
}
