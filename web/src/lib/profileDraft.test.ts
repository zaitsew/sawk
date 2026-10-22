import { describe, expect, it } from "vitest";
import type { Profile } from "../types";
import { buildPatch, toDraft } from "./profileDraft";

const base: Profile = {
  homeCity: "Valencia", homeCountry: "ES", homeTz: "Europe/Madrid", langs: ["es", "en"], likes: ["jazz"],
  avoids: ["clubs"], notes: "Small rooms.", priceMax: 30, currency: "EUR", maxPerDay: 4, updatedAt: "2026-10-20T00:00:00Z",
};

describe("profile draft", () => {
  it("sends nothing when nothing changed", () => {
    expect(buildPatch(base, toDraft(base))).toEqual({});
  });

  it("sends only the changed fields, never the rest of the profile", () => {
    const d = { ...toDraft(base), maxPerDay: 6 };
    expect(buildPatch(base, d)).toEqual({ maxPerDay: 6 });
    const d2 = { ...toDraft(base), likes: ["jazz", "markets"] };
    expect(buildPatch(base, d2)).toEqual({ likes: ["jazz", "markets"] });
  });

  it("keeps the space inside a multi-word city while typing, and trims on save", () => {
    // The draft holds the raw text, so "New " (mid-typing) and "New York" are both stored as typed.
    const typing = { ...toDraft(base), homeCity: "New " };
    expect(typing.homeCity).toBe("New ");
    const done = { ...toDraft(base), homeCity: "  New York " };
    expect(buildPatch(base, done)).toEqual({ homeCity: "New York" });
  });

  it("clears a text field to null when it is emptied, and upper-cases the country", () => {
    const d = { ...toDraft(base), homeCity: "   ", homeCountry: "us" };
    expect(buildPatch(base, d)).toEqual({ homeCity: null, homeCountry: "US" });
  });

  it("does not mistake an untouched empty profile field for a change", () => {
    const empty: Profile = { ...base, homeCity: null, homeCountry: null, homeTz: null, priceMax: null };
    expect(buildPatch(empty, toDraft(empty))).toEqual({});
  });

  it("never sends updatedAt", () => {
    expect("updatedAt" in buildPatch(base, { ...toDraft(base), notes: "x" })).toBe(false);
  });
});
