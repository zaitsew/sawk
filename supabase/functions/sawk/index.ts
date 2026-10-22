// SAWk's edge function: MCP at /mcp, REST at /api, OAuth metadata under /.well-known.
// Everything is in `handler.ts`; deploy with `supabase functions deploy sawk --no-verify-jwt`.

import { handle } from "./handler.ts";

Deno.serve((req) =>
  handle(req).catch((e) => {
    // The message of an internal error can carry data; log the kind only.
    console.error(JSON.stringify({ ev: "error", name: e instanceof Error ? e.name : "unknown" }));
    return new Response(JSON.stringify({ error: "internal" }), {
      status: 500,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  })
);
