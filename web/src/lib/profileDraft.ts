import type { Profile } from "../types";

/** What the form edits. The three text fields that can be cleared are held as typed (raw
 *  strings), so a space between two words survives; they are trimmed when the form is saved. */
export interface ProfileDraft extends Omit<Profile, "homeCity" | "homeCountry" | "homeTz" | "updatedAt"> {
  homeCity: string;
  homeCountry: string;
  homeTz: string;
}

export function toDraft(p: Profile): ProfileDraft {
  return {
    homeCity: p.homeCity ?? "",
    homeCountry: p.homeCountry ?? "",
    homeTz: p.homeTz ?? "",
    langs: p.langs, likes: p.likes, avoids: p.avoids, notes: p.notes,
    priceMax: p.priceMax, currency: p.currency, maxPerDay: p.maxPerDay,
  };
}

/** Empty (after trimming) means "clear it". */
const orNull = (v: string): string | null => (v.trim() === "" ? null : v.trim());

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Only the fields the person changed, against the profile the server last sent. Sending a
 *  whole profile would overwrite fields the form never showed or could not load. */
export function buildPatch(base: Profile, d: ProfileDraft): Partial<Profile> {
  const patch: Partial<Profile> = {};
  const city = orNull(d.homeCity);
  const country = orNull(d.homeCountry)?.toUpperCase() ?? null;
  const tz = orNull(d.homeTz);
  if (city !== base.homeCity) patch.homeCity = city;
  if (country !== base.homeCountry) patch.homeCountry = country;
  if (tz !== base.homeTz) patch.homeTz = tz;
  if (!sameList(d.langs, base.langs)) patch.langs = d.langs;
  if (!sameList(d.likes, base.likes)) patch.likes = d.likes;
  if (!sameList(d.avoids, base.avoids)) patch.avoids = d.avoids;
  const notes = d.notes.trim();
  if (notes !== base.notes.trim()) patch.notes = notes;
  if (d.priceMax !== base.priceMax) patch.priceMax = d.priceMax;
  const cur = d.currency.trim().toUpperCase();
  if (cur !== base.currency) patch.currency = cur;
  if (d.maxPerDay !== base.maxPerDay) patch.maxPerDay = d.maxPerDay;
  return patch;
}
