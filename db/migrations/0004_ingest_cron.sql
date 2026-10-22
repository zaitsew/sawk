-- SAWk 0004 — the daily ingest call.
--
-- pg_cron runs sawk.ingest_kick() at 04:30 UTC. It POSTs to the `sawk-ingest`
-- edge function through pg_net, with the shared secret in `x-sawk-cron`. Both
-- the function's base URL and the secret come from Supabase Vault:
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'sawk_functions_url');
--   select vault.create_secret('<random string>',                        'sawk_cron_secret');
--
-- and the function gets the same string as SAWK_CRON_SECRET
-- (`supabase secrets set SAWK_CRON_SECRET=...`).
--
-- Without pg_cron, pg_net or Vault (PGlite in tests, a plain self-hosted
-- Postgres) this migration still applies: the function is created, nothing is
-- scheduled, and calling it says what is missing. Self-hosters call the
-- function from their own scheduler.

create or replace function sawk.ingest_kick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_url    text;
  v_id     bigint;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'ingest_kick: Vault is not available on this database — nothing sent';
  end if;
  execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'sawk_cron_secret' limit 1 $q$ into v_secret;
  execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'sawk_functions_url' limit 1 $q$ into v_url;
  if v_secret is null or v_secret = '' then
    raise exception 'ingest_kick: vault secret sawk_cron_secret is not set — nothing sent';
  end if;
  if v_url is null or v_url = '' then
    raise exception 'ingest_kick: vault secret sawk_functions_url is not set — nothing sent';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'ingest_kick: pg_net is not installed — nothing sent';
  end if;
  execute $q$
    select net.http_post(
      url := $1,
      body := '{}'::jsonb,
      headers := jsonb_build_object('content-type', 'application/json', 'x-sawk-cron', $2),
      timeout_milliseconds := 120000)
  $q$ into v_id using rtrim(v_url, '/') || '/sawk-ingest', v_secret;
  return v_id;
end $$;

revoke all on function sawk.ingest_kick() from public;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      execute $q$ select cron.unschedule('sawk-ingest') $q$;
    exception when others then null;
    end;
    execute $q$ select cron.schedule('sawk-ingest', '30 4 * * *', 'select sawk.ingest_kick()') $q$;
    raise notice 'pg_cron: sawk-ingest scheduled daily at 04:30 UTC';
  else
    raise notice 'pg_cron not installed: sawk-ingest is not scheduled';
  end if;
end $$;
