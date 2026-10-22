import { describe, expect, it } from "vitest";
import { fx } from "./fixtures";
import { applyFeedback, FACES, matchesFilter, needsRating, nextState, reconcile, undoAction } from "./store";

describe("feedback state transitions", () => {
  it("maps each action to a state", () => {
    expect(nextState("new", "save")).toBe("saved");
    expect(nextState("saved", "unsave")).toBe("new");
    expect(nextState("saved", "going")).toBe("going");
    expect(nextState("going", "hide")).toBe("hidden");
    expect(nextState("going", "skip")).toBe("skipped");
    expect(nextState("going", "went")).toBe("went");
  });
  it("turns a rating on something planned into went, and leaves other states alone", () => {
    expect(nextState("going", "rate")).toBe("went");
    expect(nextState("saved", "rate")).toBe("went");
    expect(nextState("new", "rate")).toBe("new");
  });
  it("applies an action to one item only, and records the rating", () => {
    const items = [fx({ id: "a", state: "going" }), fx({ id: "b" })];
    const out = applyFeedback(items, "a", "rate", 2);
    expect(out[0].state).toBe("went");
    expect(out[0].rating).toBe(2);
    expect(out[1]).toBe(items[1]);
    expect(items[0].state).toBe("going"); // not mutated
  });
  it("hide then undo returns to the earlier state", () => {
    for (const prev of ["new", "saved", "going"] as const) {
      const start = [fx({ id: "a", state: prev })];
      const hidden = applyFeedback(start, "a", "hide");
      expect(hidden[0].state).toBe("hidden");
      const back = applyFeedback(hidden, "a", undoAction(prev));
      expect(back[0].state).toBe(prev);
    }
  });
  it("takes the server's row once it answers", () => {
    const items = [fx({ id: "a", state: "saved" })];
    const row = fx({ id: "a", state: "going", rating: null });
    expect(reconcile(items, row)[0].state).toBe("going");
  });
});

describe("filters and prompts", () => {
  it("never shows hidden items, and filters saved and going", () => {
    const saved = fx({ state: "saved" }), going = fx({ state: "going" }), hidden = fx({ state: "hidden" });
    expect(matchesFilter(hidden, "all")).toBe(false);
    expect(matchesFilter(saved, "all")).toBe(true);
    expect(matchesFilter(saved, "saved")).toBe(true);
    expect(matchesFilter(going, "saved")).toBe(false);
    expect(matchesFilter(going, "going")).toBe(true);
  });
  it("asks 'How was it?' only for past, planned, unrated items", () => {
    expect(needsRating(fx({ state: "going" }), true)).toBe(true);
    expect(needsRating(fx({ state: "saved" }), true)).toBe(true);
    expect(needsRating(fx({ state: "going" }), false)).toBe(false);
    expect(needsRating(fx({ state: "new" }), true)).toBe(false);
    expect(needsRating(fx({ state: "went", rating: 1 }), true)).toBe(false);
    expect(needsRating(fx({ state: "skipped" }), true)).toBe(false);
  });
  it("has five faces for −2 … 2", () => {
    expect(FACES.map((f) => f.rating)).toEqual([-2, -1, 0, 1, 2]);
    expect(FACES.map((f) => f.face)).toEqual(["🤢", "👎", "😐", "👍", "❤️"]);
  });
});
