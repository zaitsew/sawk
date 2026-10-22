// Postgres, directly. Schema `sawk` is never exposed through PostgREST; the
// functions connect with SUPABASE_DB_URL (set by Supabase in every edge
// function) or DATABASE_URL (self-host, tests).
//
// `Sql` is the tagged-template interface both postgres.js and the PGlite
// adapter in tests satisfy, so code under test runs the same queries.

import postgres from "npm:postgres@3.4.5";

export type Row = Record<string, unknown>;

export interface Sql {
  <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  /** Run `fn` in one transaction. */
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  /** A JSON parameter (jsonb columns). */
  json(value: unknown): unknown;
  /** A text[] parameter. */
  array(value: string[]): unknown;
}

let shared: Sql | undefined;

export function db(): Sql {
  if (shared) return shared;
  const url = Deno.env.get("SUPABASE_DB_URL") ?? Deno.env.get("DATABASE_URL");
  if (!url) throw new Error("SUPABASE_DB_URL (or DATABASE_URL) is not set");
  // prepare: false — Supabase's pooler (transaction mode) does not keep prepared statements.
  const pg = postgres(url, { max: 3, prepare: false, idle_timeout: 20, connection: { application_name: "sawk" } });
  shared = pg as unknown as Sql;
  return shared;
}

/** For tests: use this Sql instead of a real connection. */
export function setDb(sql: Sql | undefined) {
  shared = sql;
}
