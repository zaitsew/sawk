// One polite fetch for every adapter: identifying User-Agent, a timeout and a
// size cap, so a slow or huge page cannot stall the daily run.

import type { Fetch } from "./types.ts";

export const USER_AGENT = "SAWk/0.1 (+https://github.com/zaitsew/sawk)";
export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 3 * 1024 * 1024;

export type FetchResult =
  | { ok: true; text: string; url: string; contentType: string }
  | { ok: false; error: string };

export async function fetchText(
  f: Fetch,
  url: string,
  opts: { accept?: string; timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  try {
    const res = await f(url, {
      headers: { "user-agent": USER_AGENT, accept: opts.accept ?? "*/*", ...opts.headers },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `response too large (${declared} bytes, cap ${maxBytes})` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, error: `response too large (cap ${maxBytes} bytes)` };
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { ok: true, text: decode(bytes, contentType), url: res.url || url, contentType };
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") return { ok: false, error: "timeout" };
    return { ok: false, error: `fetch failed: ${err.message}` };
  }
}

function decode(bytes: Uint8Array, contentType: string): string {
  let label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!label) {
    // <meta charset> within the first 2 KB
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 2048));
    label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
