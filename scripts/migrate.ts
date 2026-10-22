// Applies db/migrations/*.sql in name order, each once, each in its own
// transaction. The ledger is sawk.migrations, not Supabase's own migration
// history, so SAWk can live in a project another repo migrates (Loco).
//
//   DATABASE_URL=postgres://… deno task migrate          apply what is pending
//   DATABASE_URL=postgres://… deno task migrate --dry    list what is pending

import postgres from "npm:postgres@3.4.5";

const dry = Deno.args.includes("--dry");
const url = Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!url) {
  console.error("DATABASE_URL is not set. Use the project's direct connection string (Settings → Database).");
  Deno.exit(2);
}

const dir = new URL("../db/migrations/", import.meta.url);
const files: string[] = [];
for await (const f of Deno.readDir(dir)) if (f.isFile && /^\d{4}_.+\.sql$/.test(f.name)) files.push(f.name);
files.sort();

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const [{ present }] = await sql`select to_regclass('sawk.migrations') is not null as present`;
  const done = new Set<string>(
    present ? (await sql`select version from sawk.migrations`).map((r) => r.version as string) : [],
  );
  const pending = files.filter((f) => !done.has(f.slice(0, 4)));
  if (pending.length === 0) console.log("up to date");
  for (const name of pending) {
    if (dry) {
      console.log(`pending ${name}`);
      continue;
    }
    const text = await Deno.readTextFile(new URL(name, dir));
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into sawk.migrations (version) values (${name.slice(0, 4)})`;
    });
    console.log(`applied ${name}`);
  }
} finally {
  await sql.end();
}
