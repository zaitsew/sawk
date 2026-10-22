// Applies db/migrations/*.sql in name order, each once, each in its own
// transaction. The ledger is sawk.migrations, not Supabase's own migration
// history, so SAWk can live in a project another repo migrates (Loco).
//
//   DATABASE_URL=postgres://… deno task migrate          apply what is pending
//   deno task migrate --dry                               list what is pending
//
// Two ways in, the first one set wins:
//   DATABASE_URL            a direct Postgres connection string
//   SUPABASE_PROJECT_REF    the Supabase management API, with SUPABASE_ACCESS_TOKEN
//                           (or the token `supabase login` keeps in the macOS Keychain)
// Never use Supabase's own migration tooling here: its ledger is the host project's.

import postgres from "npm:postgres@3.4.5";

const dry = Deno.args.includes("--dry");

interface Runner {
  query(text: string): Promise<Record<string, unknown>[]>;
  /** Runs `text` and records `version`, atomically. */
  apply(text: string, version: string): Promise<void>;
  close(): Promise<void>;
}

function direct(url: string): Runner {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  return {
    query: (text) => sql.unsafe(text) as unknown as Promise<Record<string, unknown>[]>,
    apply: (text, version) =>
      sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into sawk.migrations (version) values (${version})`;
      }).then(() => {}),
    close: () => sql.end(),
  };
}

async function keychainToken(): Promise<string | undefined> {
  try {
    const out = await new Deno.Command("security", { args: ["find-generic-password", "-s", "Supabase CLI", "-w"], stderr: "null" }).output();
    if (!out.success) return undefined;
    let tok = new TextDecoder().decode(out.stdout).trim();
    if (tok.startsWith("go-keyring-base64:")) tok = atob(tok.split(":", 2)[1]);
    return tok || undefined;
  } catch {
    return undefined;
  }
}

function managementApi(ref: string, token: string): Runner {
  const query = async (text: string) => {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: text }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`management API ${res.status}: ${body.slice(0, 500)}`);
    return JSON.parse(body) as Record<string, unknown>[];
  };
  return {
    query,
    // One request is one transaction only if it says so.
    apply: async (text, version) => {
      await query(`begin;\n${text}\n;insert into sawk.migrations (version) values ('${version.replace(/'/g, "")}');\ncommit;`);
    },
    close: async () => {},
  };
}

async function runner(): Promise<Runner> {
  const url = Deno.env.get("DATABASE_URL");
  if (url) return direct(url);
  const ref = Deno.env.get("SUPABASE_PROJECT_REF");
  if (ref) {
    const token = Deno.env.get("SUPABASE_ACCESS_TOKEN") ?? await keychainToken();
    if (!token) throw new Error("SUPABASE_PROJECT_REF is set but no SUPABASE_ACCESS_TOKEN (run `supabase login`)");
    return managementApi(ref, token);
  }
  throw new Error("Set DATABASE_URL, or SUPABASE_PROJECT_REF (+ SUPABASE_ACCESS_TOKEN). See .env.example.");
}

const dir = new URL("../db/migrations/", import.meta.url);
const files: string[] = [];
for await (const f of Deno.readDir(dir)) if (f.isFile && /^\d{4}_.+\.sql$/.test(f.name)) files.push(f.name);
files.sort();

let db: Runner;
try {
  db = await runner();
} catch (e) {
  console.error((e as Error).message);
  Deno.exit(2);
}
try {
  const [{ present }] = await db.query(`select to_regclass('sawk.migrations') is not null as present`);
  const done = new Set<string>(
    present ? (await db.query(`select version from sawk.migrations`)).map((r) => r.version as string) : [],
  );
  const pending = files.filter((f) => !done.has(f.slice(0, 4)));
  if (pending.length === 0) console.log("up to date");
  for (const name of pending) {
    if (dry) {
      console.log(`pending ${name}`);
      continue;
    }
    await db.apply(await Deno.readTextFile(new URL(name, dir)), name.slice(0, 4));
    console.log(`applied ${name}`);
  }
} finally {
  await db.close();
}
