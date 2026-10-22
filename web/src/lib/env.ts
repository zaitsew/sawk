/** Build-time configuration, in one place. */
const env = import.meta.env;

export const SUPABASE_URL: string = (env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
export const SUPABASE_ANON_KEY: string = env.VITE_SUPABASE_ANON_KEY ?? "";

/** Mock mode exists only in `vite dev`: `import.meta.env.DEV` is false in a production build,
 *  so this folds to `false` and the sample data is dropped from the bundle. */
export const MOCK: boolean = env.DEV && env.VITE_SAWK_MOCK === "1";

export const OAUTH: boolean = env.VITE_SAWK_OAUTH === "1";

export const API_BASE: string = (
  env.VITE_SAWK_API || (MOCK ? "https://sample.invalid/functions/v1/sawk" : `${SUPABASE_URL}/functions/v1/sawk`)
).replace(/\/$/, "");

/** The MCP endpoint agents connect to. */
export const MCP_URL = `${API_BASE}/mcp`;

export const CONFIGURED = MOCK || (SUPABASE_URL !== "" && SUPABASE_ANON_KEY !== "");
