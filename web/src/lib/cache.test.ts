import { beforeEach, describe, expect, it } from "vitest";
import { loadSnapshot, recordFeedback, recordProfile, saveSnapshot, type Snapshot } from "./cache";
import { fx } from "./fixtures";
import type { Profile } from "../types";

const profile: Profile = {
  homeCity: "Valencia", homeCountry: "ES", homeTz: "Europe/Madrid", langs: ["es"], likes: [], avoids: [],
  notes: "", priceMax: null, currency: "EUR", maxPerDay: 3,
};

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return { savedAt: 1000, userId: "u1", items: [fx({ id: "a" }), fx({ id: "b", state: "going" })], windows: [], profile, ...over };
}

beforeEach(() => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  } as unknown as Storage;
});

describe("offline snapshot after feedback", () => {
  it("stores the server's row for the item, so reopening offline shows it", () => {
    saveSnapshot(snap());
    recordFeedback("u1", "a", "save", undefined, fx({ id: "a", state: "saved", reason: "From the server." }));
    const out = loadSnapshot("u1")!;
    expect(out.items[0].state).toBe("saved");
    expect(out.items[0].reason).toBe("From the server.");
    expect(out.items[1].state).toBe("going"); // others untouched
  });

  it("applies the action itself when the server sends no row", () => {
    saveSnapshot(snap());
    recordFeedback("u1", "b", "rate", 2, null);
    const out = loadSnapshot("u1")!;
    expect(out.items[1].state).toBe("went");
    expect(out.items[1].rating).toBe(2);
    recordFeedback("u1", "a", "hide", undefined, null);
    expect(loadSnapshot("u1")!.items[0].state).toBe("hidden");
  });

  it("keeps savedAt, windows and profile", () => {
    saveSnapshot(snap());
    recordFeedback("u1", "a", "save", undefined, null);
    const out = loadSnapshot("u1")!;
    expect(out.savedAt).toBe(1000);
    expect(out.profile).toEqual(profile);
  });

  it("does nothing when there is no snapshot, or it belongs to someone else", () => {
    recordFeedback("u1", "a", "save", undefined, null);
    expect(loadSnapshot("u1")).toBeNull();
    saveSnapshot(snap({ userId: "u2" }));
    recordFeedback("u1", "a", "save", undefined, null);
    expect(loadSnapshot("u2")!.items[0].state).toBe("new");
  });

  it("stores a saved profile too", () => {
    saveSnapshot(snap());
    recordProfile("u1", { ...profile, maxPerDay: 6 });
    expect(loadSnapshot("u1")!.profile?.maxPerDay).toBe(6);
  });
});
