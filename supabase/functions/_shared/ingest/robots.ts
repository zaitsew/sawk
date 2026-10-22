// robots.txt for the pages the JSON-LD adapter reads (RFC 9309, the parts that
// matter): our own group (`SAWk`) else `*`; Allow/Disallow with * and $; the
// longest matching rule wins and Allow wins a tie. A missing file (4xx) allows
// everything; an unreachable one (5xx, network) blocks the page for this run.

import { fetchText } from "./http.ts";
import type { Fetch } from "./types.ts";

export const PRODUCT_TOKEN = "sawk";

interface Rule {
  allow: boolean;
  pattern: string;
}

export function parseRobots(text: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (value) cur.rules.push({ allow: key === "allow", pattern: value });
    } else lastWasAgent = false;
  }
  const own = groups.filter((g) => g.agents.some((a) => a === PRODUCT_TOKEN));
  const picked = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  return picked.flatMap((g) => g.rules);
}

function matches(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    "^" + body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""),
  );
  return re.test(target);
}

/** `target` is the path plus query, e.g. "/d/spain--valencia/events/?page=2". */
export function isAllowed(rules: Rule[], target: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!matches(r.pattern, target)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) {
      best = r;
    }
  }
  return best ? best.allow : true;
}

type Cached = Rule[] | "unreachable";

export async function robotsAllows(
  f: Fetch,
  url: string,
  cache: Map<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const u = new URL(url);
  const key = `robots:${u.origin}`;
  let pending = cache.get(key) as Promise<Cached> | undefined;
  if (!pending) {
    pending = (async (): Promise<Cached> => {
      const res = await fetchText(f, `${u.origin}/robots.txt`, { maxBytes: 512 * 1024, accept: "text/plain" });
      if (res.ok) return parseRobots(res.text);
      const status = /^HTTP (\d{3})$/.exec(res.error);
      return status && status[1][0] === "4" ? [] : "unreachable";
    })();
    cache.set(key, pending);
  }
  const rules = await pending;
  if (rules === "unreachable") return { ok: false, error: `robots.txt of ${u.host} is unreachable` };
  return isAllowed(rules, u.pathname + u.search)
    ? { ok: true }
    : { ok: false, error: `disallowed by robots.txt of ${u.host}` };
}
