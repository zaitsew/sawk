// The event id: the same concert from two sources must land on one row.
//
// Key = normalised title | local start date | normalised venue | normalised city.
// The local date is the event's own day in its time zone (falling back to the
// offset written in startsAt), so 23:30 in Valencia is not "tomorrow" in UTC.

/** Lowercase, strip accents and punctuation, collapse spaces, drop a few filler words. */
export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(the|el|la|los|las|le|les|il|concierto|concert|live|en directo)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** YYYY-MM-DD of `startsAt` in `tz`; without a zone, the date as written. */
export function localDate(startsAt: string, tz?: string | null): string {
  if (tz) {
    try {
      const d = new Date(startsAt);
      if (!isNaN(d.getTime())) {
        return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      }
    } catch { /* unknown zone: fall through */ }
  }
  return startsAt.slice(0, 10);
}

export async function eventId(e: { title: string; startsAt: string; tz?: string | null; venue?: string | null; city: string }): Promise<string> {
  const key = [norm(e.title), localDate(e.startsAt, e.tz), norm(e.venue), norm(e.city)].join("|");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return "ev_" + Array.from(bytes.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
