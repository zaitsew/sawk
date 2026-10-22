import type { Event } from "../types";

function money(n: number, currency: string, withSymbol: boolean): string {
  const frac = Number.isInteger(n) ? 0 : 2;
  try {
    const nf = new Intl.NumberFormat("en", {
      style: withSymbol ? "currency" : "decimal",
      ...(withSymbol ? { currency, currencyDisplay: "narrowSymbol" } : {}),
      minimumFractionDigits: frac,
      maximumFractionDigits: frac,
    });
    return nf.format(n);
  } catch {
    return `${n}${withSymbol ? ` ${currency}` : ""}`;
  }
}

/** "Free", "€12–15", "€12", "From €12", or null when the event says nothing. */
export function formatPrice(e: Pick<Event, "isFree" | "priceMin" | "priceMax" | "currency">, fallbackCurrency = "EUR"): string | null {
  const { priceMin: lo, priceMax: hi } = e;
  if (e.isFree === true) return "Free";
  if (lo === 0 && (hi == null || hi === 0)) return "Free";
  const cur = e.currency || fallbackCurrency;
  if (lo != null && hi != null && hi !== lo) return `${money(lo, cur, true)}–${money(hi, cur, false)}`;
  if (lo != null && hi != null) return money(lo, cur, true);
  if (lo != null) return `From ${money(lo, cur, true)}`;
  if (hi != null) return `Up to ${money(hi, cur, true)}`;
  return null;
}
