import type { Action, FeedItem, Profile, Run, TokenCreated, TokenRow, Window } from "../types";
import { API_BASE } from "./env";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  base: string;
  /** The session's access token, or null when signed out. */
  getToken: () => Promise<string | null> | string | null;
  /** Called on a 401: the session is no good, sign out. */
  onUnauthorized: () => void;
  fetchImpl?: typeof fetch;
  /** Dev-only: answer from sample data instead of the network. */
  mock?: (method: string, path: string, body: unknown) => Promise<unknown>;
}

export interface FeedQuery {
  from?: string;
  to?: string;
  city?: string;
  state?: string;
  limit?: number;
}

export type Api = ReturnType<typeof createApi>;

export function createApi(o: ApiOptions) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (o.mock) return (await o.mock(method, path, body ?? null)) as T;
    const token = await o.getToken();
    const headers: Record<string, string> = { "x-sawk-client": "web", accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await (o.fetchImpl ?? fetch)(`${o.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "Could not reach SAWk. Check your connection and try again.");
    }
    if (res.status === 401) {
      o.onUnauthorized();
      throw new ApiError(401, "Your session ended. Sign in again.");
    }
    if (!res.ok) {
      let msg = `SAWk answered ${res.status}.`;
      try {
        const j = (await res.json()) as { error?: unknown; message?: unknown };
        const m = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
        if (m) msg = m;
      } catch { /* keep the generic message */ }
      throw new ApiError(res.status, msg);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const qs = (q: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return {
    call,
    async feed(q: FeedQuery = {}): Promise<FeedItem[]> {
      const r = await call<FeedItem[] | { items: FeedItem[] }>("GET", `/api/feed${qs({ ...q })}`);
      return Array.isArray(r) ? r : r.items ?? [];
    },
    /** Windows (home + trips) come from the context call. */
    async windows(days = 30): Promise<Window[]> {
      const r = await call<{ windows?: Window[] }>("GET", `/api/context?days=${days}`);
      return r.windows ?? [];
    },
    async feedback(eventId: string, action: Action, rating?: number): Promise<FeedItem | null> {
      const r = await call<FeedItem | { item?: FeedItem } | undefined>("POST", "/api/feedback", {
        eventId, action, ...(rating !== undefined ? { rating } : {}),
      });
      if (r && typeof r === "object" && "event" in r && "state" in r) return r as FeedItem;
      return null;
    },
    async profile(): Promise<Profile> {
      const r = await call<Profile | { profile: Profile }>("GET", "/api/profile");
      return "profile" in r ? r.profile : r;
    },
    async saveProfile(p: Partial<Profile>): Promise<Profile> {
      const r = await call<Profile | { profile: Profile }>("PUT", "/api/profile", p);
      return "profile" in r ? r.profile : r;
    },
    async runs(limit = 20): Promise<Run[]> {
      const r = await call<Run[] | { runs: Run[] }>("GET", `/api/runs${qs({ limit })}`);
      return Array.isArray(r) ? r : r.runs ?? [];
    },
    async tokens(): Promise<TokenRow[]> {
      const r = await call<TokenRow[] | { tokens: TokenRow[] }>("GET", "/api/tokens");
      return Array.isArray(r) ? r : r.tokens ?? [];
    },
    createToken: (name: string) => call<TokenCreated>("POST", "/api/tokens", { name }),
    async revokeToken(id: string): Promise<void> {
      await call<unknown>("DELETE", `/api/tokens/${encodeURIComponent(id)}`);
    },
  };
}

// --- the app's instance -------------------------------------------------------------------------

let handlers: Pick<ApiOptions, "getToken" | "onUnauthorized"> = {
  getToken: () => null,
  onUnauthorized: () => {},
};

/** Auth wires itself in here, so the api module never imports supabase-js. */
export function setApiAuth(h: Pick<ApiOptions, "getToken" | "onUnauthorized">) {
  handlers = h;
}

export const api: Api = createApi({
  base: API_BASE,
  getToken: () => handlers.getToken(),
  onUnauthorized: () => handlers.onUnauthorized(),
  // Written inline so the bundler folds it away: `import.meta.env.DEV` is false in a production build.
  mock: import.meta.env.DEV && import.meta.env.VITE_SAWK_MOCK === "1"
    ? async (m, p, b) => (await import("./mock")).handle(m, p, b)
    : undefined,
});
