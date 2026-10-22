import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";

function make(res: Response | (() => Response), token: string | null = "tok-123") {
  const fetchImpl = vi.fn(async () => (typeof res === "function" ? res() : res));
  const onUnauthorized = vi.fn();
  const api = createApi({ base: "https://x.test/functions/v1/sawk", getToken: () => token, onUnauthorized, fetchImpl: fetchImpl as unknown as typeof fetch });
  return { api, fetchImpl, onUnauthorized };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client", () => {
  it("sends the session token as Bearer and the client header", async () => {
    const { api, fetchImpl } = make(json([]));
    await api.feed({ from: "2026-10-20", limit: 50 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.test/functions/v1/sawk/api/feed?from=2026-10-20&limit=50");
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer tok-123");
    expect(h["x-sawk-client"]).toBe("web");
  });

  it("omits Authorization when signed out", async () => {
    const { api, fetchImpl } = make(json([]), null);
    await api.feed();
    const h = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(h.authorization).toBeUndefined();
  });

  it("posts feedback as JSON", async () => {
    const { api, fetchImpl } = make(json({ ok: true }));
    await api.feedback("e1", "rate", 2);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ eventId: "e1", action: "rate", rating: 2 });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("signs out on a 401", async () => {
    const { api, onUnauthorized } = make(json({ error: "bad token" }, 401));
    await expect(api.profile()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("surfaces the server's message on other errors, and does not sign out", async () => {
    const { api, onUnauthorized } = make(json({ error: "name is required" }, 400));
    await expect(api.createToken("")).rejects.toThrow("name is required");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("turns a network failure into a readable error", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({ base: "https://x.test", getToken: () => "t", onUnauthorized, fetchImpl: (async () => { throw new TypeError("fail"); }) as unknown as typeof fetch });
    const err = await api.runs().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it("accepts a bare array or a wrapped object for lists", async () => {
    expect(await make(json({ items: [{ a: 1 }] })).api.feed()).toEqual([{ a: 1 }]);
    expect(await make(json([{ a: 1 }])).api.feed()).toEqual([{ a: 1 }]);
    expect(await make(json({ windows: [{ city: "X" }] })).api.windows()).toEqual([{ city: "X" }]);
  });
});
