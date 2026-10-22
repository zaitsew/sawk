import { describe, expect, it } from "vitest";
import { formatPrice } from "./price";

const p = (o: Parameters<typeof formatPrice>[0]) => formatPrice(o);
const base = { isFree: null, priceMin: null, priceMax: null, currency: "EUR" };

describe("formatPrice", () => {
  it("says Free", () => {
    expect(p({ ...base, isFree: true })).toBe("Free");
    expect(p({ ...base, priceMin: 0, priceMax: 0 })).toBe("Free");
    expect(p({ ...base, priceMin: 0 })).toBe("Free");
  });
  it("writes a range with one symbol", () => {
    expect(p({ ...base, priceMin: 12, priceMax: 15 })).toBe("€12–15");
  });
  it("writes a single price", () => {
    expect(p({ ...base, priceMin: 12, priceMax: 12 })).toBe("€12");
  });
  it("keeps cents only when there are some", () => {
    expect(p({ ...base, priceMin: 12.5, priceMax: 15 })).toBe("€12.50–15");
  });
  it("handles one-sided prices", () => {
    expect(p({ ...base, priceMin: 20 })).toBe("From €20");
    expect(p({ ...base, priceMax: 20 })).toBe("Up to €20");
  });
  it("uses the event's currency", () => {
    expect(p({ ...base, currency: "USD", priceMin: 5, priceMax: 8 })).toBe("$5–8");
    expect(p({ ...base, currency: "JPY", priceMin: 1500, priceMax: 2000 })).toBe("¥1,500–2,000");
  });
  it("says nothing when the event does not", () => {
    expect(p(base)).toBeNull();
  });
});
