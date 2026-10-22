// An in-memory Postgres for tests (PGlite), wrapped in the same `Sql`
// interface as postgres.js, with every migration in db/migrations applied.
// No Docker, no network.

import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import type { Row, Sql } from "./db.ts";

const MIGRATIONS = new URL("../../../db/migrations/", import.meta.url);

type Exec = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

function wrap(pg: Exec, begin: Sql["begin"]): Sql {
  const tag = (async <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
    const params = values.map((v) => (v instanceof Marked ? v.value : v));
    const res = await pg.query(text, params);
    return res.rows as T[];
  }) as Sql;
  tag.begin = begin;
  tag.json = (value: unknown) => new Marked(JSON.stringify(value));
  tag.array = (value: string[]) => new Marked(value);
  return tag;
}

class Marked {
  constructor(public value: unknown) {}
}

export async function testDb(): Promise<{ sql: Sql; close: () => Promise<void>; exec: (text: string) => Promise<void> }> {
  const pg = await PGlite.create();
  // Supabase's roles, so the migrations' grants and revokes run as they do there.
  await pg.exec(`create role anon nologin; create role authenticated nologin;`);
  const files: string[] = [];
  for await (const f of Deno.readDir(MIGRATIONS)) if (f.isFile && f.name.endsWith(".sql")) files.push(f.name);
  for (const name of files.sort()) await pg.exec(await Deno.readTextFile(new URL(name, MIGRATIONS)));

  const begin: Sql["begin"] = (fn) => pg.transaction((tx) => fn(wrap(tx, begin)));
  return { sql: wrap(pg, begin), close: () => pg.close(), exec: async (text) => { await pg.exec(text); } };
}
