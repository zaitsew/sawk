-- SAWk 0002 — the Loco adapter: what SAWk reads from Loco, read only.
--
-- Signatures are the contract the `sawk` function calls. Each returns nothing
-- when Loco's tables are absent (self-host), so callers never branch on it.
-- Bodies: lane E (docs/PLAN.md). Until then they are stubs returning empty.

-- Home, from Loco's profile.
create or replace function sawk.loco_home(p_user uuid)
returns table (city text, country text, tz text)
language plpgsql stable security definer set search_path = '' as $$
begin
  return;
end $$;

-- The cities the person sleeps in between p_from and p_to, from their own Loco
-- trips (stays they are on), clipped to the range. Home days are not included.
create or replace function sawk.loco_windows(p_user uuid, p_from date, p_to date)
returns table (city text, country text, tz text, starts_on date, ends_on date, trip text)
language plpgsql stable security definer set search_path = '' as $$
begin
  return;
end $$;

-- What is already planned: Loco events and moves the person is on, per day.
create or replace function sawk.loco_busy(p_user uuid, p_from date, p_to date)
returns table (day date, title text, starts_at timestamptz, ends_at timestamptz, city text, kind text)
language plpgsql stable security definer set search_path = '' as $$
begin
  return;
end $$;

-- Loco's taste for the person: {"reviews": n, "likes": [..], "avoids": [..],
-- "byCategory": {"<category>": {"mean": 4.5, "n": 3}}, "card": {...}}.
create or replace function sawk.loco_taste(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return '{"reviews": 0, "likes": [], "avoids": [], "byCategory": {}}'::jsonb;
end $$;

revoke all on function sawk.loco_home(uuid) from public;
revoke all on function sawk.loco_windows(uuid, date, date) from public;
revoke all on function sawk.loco_busy(uuid, date, date) from public;
revoke all on function sawk.loco_taste(uuid) from public;
