// Helpers for the tests: fixtures, a source row, and a fetch that answers from a table.

import type { Fetch, SourceRow } from "./types.ts";

export const NOW = new Date("2026-10-23T10:00:00Z");

export function fixture(name: string): Promise<string> {
  return Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));
}

export function source(over: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    city: "Valencia",
    country: "ES",
    kind: "ics",
    url: "https://venue.fixture.test/feed.ics",
    label: "Fixture",
    categories: [],
    ...over,
  };
}

export type Reply = string | { status?: number; body?: string; type?: string } | ((url: string) => Response);

/** A fetch answering from `routes` (exact URL, or an `origin/*` prefix). Unknown URLs are 404. Records the calls. */
export function fakeFetch(routes: Record<string, Reply>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const hit = routes[url] ??
      Object.entries(routes).find(([k]) => k.endsWith("*") && url.startsWith(k.slice(0, -1)))?.[1];
    if (hit === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (typeof hit === "function") return Promise.resolve(hit(url));
    if (typeof hit === "string") {
      return Promise.resolve(new Response(hit, { headers: { "content-type": "text/plain" } }));
    }
    return Promise.resolve(
      new Response(hit.body ?? "", {
        status: hit.status ?? 200,
        headers: { "content-type": hit.type ?? "text/plain" },
      }),
    );
  }) as Fetch & { calls: string[] };
  f.calls = calls;
  return f;
}
