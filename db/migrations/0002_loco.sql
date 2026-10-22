-- SAWk 0002 — the Loco adapter: what SAWk reads from Loco, read only.
--
-- Four functions are the contract the `sawk` function calls. Each returns nothing (or a
-- default) when Loco's tables are absent, so callers never branch on it. Every read of a
-- Loco table is dynamic SQL (EXECUTE), so this file compiles and runs where Loco does not
-- exist (self-host, tests) and starts working the day the tables appear.
--
-- Rules (docs/LOCO.md has the field list):
--   * Only the person's own trips: a trip_members row for them, and the stays, events and
--     moves that involve their seat (an empty `who` means everyone on the trip, as in Loco).
--   * Not trips in phase "idea", not trips moved to a newer trip, not trips the person
--     archived, not stays/events/moves whose status is "cancelled" or "idea".
--   * A stay covers the nights checkIn .. checkOut-1: the checkout day belongs to the next
--     place (or to home). A same-day stay covers its one day.

-- A date from Loco's text, or null. Never raises.
create or replace function sawk.loco_date(p_text text)
returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p_text is null or p_text !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p_text::date;
exception when others then
  return null;
end $$;

-- A time zone name Postgres knows, or null.
create or replace function sawk.loco_tz(p_name text)
returns text
language sql stable set search_path = '' as $$
  select z.name from pg_catalog.pg_timezone_names z where z.name = p_name limit 1
$$;

-- The person's own trips: (slug, their person id on the trip, the document, updated_at).
create or replace function sawk.loco_my_trips(p_user uuid)
returns table (slug text, person text, doc jsonb, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_moved boolean;
  v_archived boolean;
begin
  if p_user is null or to_regclass('public.trips') is null or to_regclass('public.trip_members') is null then
    return;
  end if;
  select exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.trips'::regclass and a.attname = 'moved_to' and not a.attisdropped)
    into v_moved;
  select exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.trip_members'::regclass and a.attname = 'archived_at' and not a.attisdropped)
    into v_archived;
  return query execute
    'select coalesce(t.slug, t.id) as slug,
            coalesce(m.person_id,
                     (select pe ->> ''id''
                        from jsonb_array_elements(case when jsonb_typeof(t.doc -> ''people'') = ''array''
                                                       then t.doc -> ''people'' else ''[]''::jsonb end) pe
                       where jsonb_typeof(pe) = ''object'' and pe ->> ''userId'' = $1::text
                       limit 1)) as person,
            t.doc, t.updated_at
       from public.trips t
       join public.trip_members m on m.trip_id = t.id and m.user_id = $1
      where jsonb_typeof(t.doc) = ''object''
        and coalesce(t.doc ->> ''phase'', '''') <> ''idea'''
        || case when v_moved then ' and t.moved_to is null' else '' end
        || case when v_archived then ' and m.archived_at is null' else '' end
    using p_user;
end $$;

-- Home, from Loco's profile (`profiles.home_place`, free text: a city name, sometimes
-- "City, CC"). Country and time zone come from a place of the person's own trips that has
-- that name or id. With no profile value, the base place of their most recent trip.
create or replace function sawk.loco_home(p_user uuid)
returns table (city text, country text, tz text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_text text;
  v_name text;
  v_cc text;
begin
  if p_user is null then return; end if;
  if to_regclass('public.profiles') is not null then
    execute 'select nullif(btrim(home_place), '''') from public.profiles where user_id = $1' into v_text using p_user;
  end if;

  if v_text is not null then
    v_name := btrim(split_part(v_text, ',', 1));
    v_cc := nullif(upper(btrim(split_part(v_text, ',', 2))), '');
    if v_cc !~ '^[A-Z]{2}$' then v_cc := null; end if;
    return query
      select coalesce(m.pl ->> 'name', v_name), coalesce(m.pl ->> 'country', v_cc), sawk.loco_tz(m.pl ->> 'timeZone')
        from (select 1) one
        left join lateral (
          select p as pl
            from sawk.loco_my_trips(p_user) t,
                 jsonb_array_elements(case when jsonb_typeof(t.doc -> 'places') = 'array'
                                           then t.doc -> 'places' else '[]'::jsonb end) p
           where jsonb_typeof(p) = 'object'
             and (lower(p ->> 'name') = lower(v_name) or lower(p ->> 'id') = lower(v_name))
           order by t.updated_at desc
           limit 1) m on true;
    return;
  end if;

  return query
    select pl ->> 'name', pl ->> 'country', sawk.loco_tz(pl ->> 'timeZone')
      from (select t.doc, t.person from sawk.loco_my_trips(p_user) t order by t.updated_at desc limit 1) tr
      cross join lateral (
        select p as pl
          from jsonb_array_elements(case when jsonb_typeof(tr.doc -> 'people') = 'array'
                                         then tr.doc -> 'people' else '[]'::jsonb end) pe,
               jsonb_array_elements(case when jsonb_typeof(tr.doc -> 'places') = 'array'
                                         then tr.doc -> 'places' else '[]'::jsonb end) p
         where pe ->> 'id' = tr.person and p ->> 'id' = pe ->> 'basePlaceId'
         limit 1) base
     where pl ->> 'name' is not null;
end $$;

-- The cities the person sleeps in between p_from and p_to, from their own Loco
-- trips (stays they are on), clipped to the range. One row per stay: nights checkIn ..
-- checkOut-1 (starts_on .. ends_on, both inclusive). Home days are not included.
-- `trip` is the trip's slug, never its title.
create or replace function sawk.loco_windows(p_user uuid, p_from date, p_to date)
returns table (city text, country text, tz text, starts_on date, ends_on date, trip text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if p_user is null or p_from is null or p_to is null then return; end if;
  return query
    with st as (
      select t.slug as slug, t.doc as doc, s as stay,
             sawk.loco_date(s ->> 'checkIn') as ci,
             sawk.loco_date(s ->> 'checkOut') as co
        from sawk.loco_my_trips(p_user) t
        cross join lateral jsonb_array_elements(case when jsonb_typeof(t.doc -> 'stays') = 'array'
                                                     then t.doc -> 'stays' else '[]'::jsonb end) s
       where t.person is not null
         and jsonb_typeof(s) = 'object'
         and coalesce(s ->> 'status', '') not in ('cancelled', 'idea')
         and (jsonb_typeof(s -> 'who') is distinct from 'array'
              or jsonb_array_length(s -> 'who') = 0
              or s -> 'who' @> to_jsonb(t.person))
    ), spans as (
      select st.slug, st.stay, pl.p as place,
             st.ci as s_from,
             greatest(st.ci, coalesce(st.co, st.ci + 1) - 1) as s_to
        from st
        cross join lateral (
          select p from jsonb_array_elements(case when jsonb_typeof(st.doc -> 'places') = 'array'
                                                  then st.doc -> 'places' else '[]'::jsonb end) p
           where jsonb_typeof(p) = 'object' and p ->> 'id' = st.stay ->> 'placeId'
           limit 1) pl
       where st.ci is not null
    )
    select sp.place ->> 'name', sp.place ->> 'country', sawk.loco_tz(sp.place ->> 'timeZone'),
           greatest(sp.s_from, p_from), least(sp.s_to, p_to), sp.slug
      from spans sp
     where sp.place ->> 'name' is not null
       and sp.s_to >= p_from and sp.s_from <= p_to
     order by greatest(sp.s_from, p_from), sp.slug;
end $$;

-- What is already planned: Loco events and moves the person is on, per day.
-- An event with a time has starts_at in its place's zone (null when the zone is unknown);
-- an event without one is all-day (starts_at null). A move's city is where it arrives.
create or replace function sawk.loco_busy(p_user uuid, p_from date, p_to date)
returns table (day date, title text, starts_at timestamptz, ends_at timestamptz, city text, kind text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if p_user is null or p_from is null or p_to is null then return; end if;
  return query
    with ev as (
      select t.slug, t.doc, e as item, sawk.loco_date(e ->> 'date') as d
        from sawk.loco_my_trips(p_user) t
        cross join lateral jsonb_array_elements(case when jsonb_typeof(t.doc -> 'events') = 'array'
                                                     then t.doc -> 'events' else '[]'::jsonb end) e
       where t.person is not null
         and jsonb_typeof(e) = 'object'
         and coalesce(e ->> 'status', '') not in ('cancelled', 'idea')
         and (jsonb_typeof(e -> 'who') is distinct from 'array'
              or jsonb_array_length(e -> 'who') = 0
              or e -> 'who' @> to_jsonb(t.person))
    ), evp as (
      select ev.*, pl.p as place, sawk.loco_tz(pl.p ->> 'timeZone') as zone,
             case when ev.item ->> 'time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then (ev.item ->> 'time')::time end as t0,
             case when ev.item ->> 'endTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then (ev.item ->> 'endTime')::time end as t1
        from ev
        left join lateral (
          select p from jsonb_array_elements(case when jsonb_typeof(ev.doc -> 'places') = 'array'
                                                  then ev.doc -> 'places' else '[]'::jsonb end) p
           where jsonb_typeof(p) = 'object' and p ->> 'id' = ev.item ->> 'placeId'
           limit 1) pl on true
       where ev.d between p_from and p_to
    ), mv as (
      select t.slug, t.doc, m as item, sawk.loco_date(m ->> 'date') as d
        from sawk.loco_my_trips(p_user) t
        cross join lateral jsonb_array_elements(case when jsonb_typeof(t.doc -> 'moves') = 'array'
                                                     then t.doc -> 'moves' else '[]'::jsonb end) m
       where t.person is not null
         and jsonb_typeof(m) = 'object'
         and coalesce(m ->> 'status', '') not in ('cancelled', 'idea')
         and (jsonb_typeof(m -> 'who') is distinct from 'array'
              or jsonb_array_length(m -> 'who') = 0
              or m -> 'who' @> to_jsonb(t.person))
    ), mvp as (
      select mv.*,
             (select p from jsonb_array_elements(case when jsonb_typeof(mv.doc -> 'places') = 'array'
                                                      then mv.doc -> 'places' else '[]'::jsonb end) p
               where jsonb_typeof(p) = 'object' and p ->> 'id' = mv.item ->> 'fromPlaceId' limit 1) as fplace,
             (select p from jsonb_array_elements(case when jsonb_typeof(mv.doc -> 'places') = 'array'
                                                      then mv.doc -> 'places' else '[]'::jsonb end) p
               where jsonb_typeof(p) = 'object' and p ->> 'id' = mv.item ->> 'toPlaceId' limit 1) as tplace,
             case when jsonb_typeof(mv.item -> 'legs') = 'array' and jsonb_array_length(mv.item -> 'legs') > 0
                  then mv.item -> 'legs' -> 0 end as first_leg,
             case when jsonb_typeof(mv.item -> 'legs') = 'array' and jsonb_array_length(mv.item -> 'legs') > 0
                  then mv.item -> 'legs' -> (jsonb_array_length(mv.item -> 'legs') - 1) end as last_leg
        from mv
       where mv.d between p_from and p_to
    )
    select evp.d,
           coalesce(nullif(btrim(evp.item ->> 'title'), ''), 'Event'),
           case when evp.t0 is not null and evp.zone is not null
                then (evp.d + evp.t0) at time zone evp.zone end,
           case when evp.t0 is not null and evp.t1 is not null and evp.zone is not null
                then ((evp.d + case when evp.t1 <= evp.t0 then 1 else 0 end) + evp.t1) at time zone evp.zone end,
           evp.place ->> 'name',
           'event'::text
      from evp
    union all
    select mvp.d,
           coalesce(mvp.fplace ->> 'name', '?') || ' → ' || coalesce(mvp.tplace ->> 'name', '?'),
           case when mvp.first_leg ->> 'dep' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                     and sawk.loco_tz(mvp.fplace ->> 'timeZone') is not null
                then (coalesce(sawk.loco_date(mvp.first_leg ->> 'date'), mvp.d) + (mvp.first_leg ->> 'dep')::time)
                     at time zone sawk.loco_tz(mvp.fplace ->> 'timeZone') end,
           case when mvp.last_leg ->> 'arr' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                     and sawk.loco_tz(mvp.tplace ->> 'timeZone') is not null
                then (coalesce(sawk.loco_date(mvp.last_leg ->> 'date'), mvp.d)
                      + case when mvp.last_leg ->> 'arrDayOffset' ~ '^[0-9]$' then (mvp.last_leg ->> 'arrDayOffset')::int else 0 end
                      + (mvp.last_leg ->> 'arr')::time)
                     at time zone sawk.loco_tz(mvp.tplace ->> 'timeZone') end,
           mvp.tplace ->> 'name',
           'move'::text
      from mvp
     order by 1, 3 nulls first, 2;
end $$;

-- Loco's taste for the person: {"reviews": n, "likes": [..], "avoids": [..],
-- "byCategory": {"<category>": {"mean": 4.5, "n": 3}}, "places": {"<kind>": {...}},
-- "card": {...} | null, "hide": [..]}.
-- A review is a moment with `about` and `rating` (1-5) written by the person. Event
-- reviews resolve the event in the trip document, map its Loco category to a SAWk one
-- (sight→art, show→theatre, nature→outdoor, shopping→market; food and sport stay;
-- anything else keeps its Loco word), and average per category. Like packages/mcp
-- src/taste.ts: likes are means >= 4.0 and avoids <= 2.5, over categories with n >= 2,
-- means to one decimal. byCategory lists every category, with n, so a reader can see
-- thin evidence. Reviews of stays and moves count in `reviews` only.
create or replace function sawk.loco_taste(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_empty constant jsonb := '{"reviews": 0, "likes": [], "avoids": [], "byCategory": {}, "places": {}, "card": null, "hide": []}';
  v_out jsonb := v_empty;
  v_reviews int := 0;
  v_rows jsonb;
  v_cat jsonb;
  v_places jsonb;
  v_likes jsonb;
  v_avoids jsonb;
  v_card jsonb;
  v_hide jsonb;
begin
  if p_user is null then return v_empty; end if;

  if to_regclass('public.moments') is not null and to_regclass('public.trips') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'key', x.key, 'rating', x.rating)), '[]'::jsonb)
        from (
          select m.about ->> 'kind' as kind,
                 case m.about ->> 'kind'
                   when 'event' then (
                     select case
                              when e ->> 'category' = 'sight' then 'art'
                              when e ->> 'category' = 'show' then 'theatre'
                              when e ->> 'category' = 'nature' then 'outdoor'
                              when e ->> 'category' = 'shopping' then 'market'
                              when e ->> 'category' ~ '^[a-z][a-z0-9_-]{0,31}$' then e ->> 'category'
                              else 'other' end
                       from jsonb_array_elements(case when jsonb_typeof(t.doc -> 'events') = 'array'
                                                      then t.doc -> 'events' else '[]'::jsonb end) e
                      where e ->> 'id' = m.about ->> 'id' limit 1)
                   when 'place' then (
                     select coalesce(nullif(p ->> 'kind', ''), 'place')
                       from jsonb_array_elements(case when jsonb_typeof(t.doc -> 'places') = 'array'
                                                      then t.doc -> 'places' else '[]'::jsonb end) p
                      where p ->> 'id' = m.about ->> 'id' limit 1)
                   when 'stay' then (
                     select 'stay'::text
                       from jsonb_array_elements(case when jsonb_typeof(t.doc -> 'stays') = 'array'
                                                      then t.doc -> 'stays' else '[]'::jsonb end) s
                      where s ->> 'id' = m.about ->> 'id' limit 1)
                   when 'move' then (
                     select 'move'::text
                       from jsonb_array_elements(case when jsonb_typeof(t.doc -> 'moves') = 'array'
                                                      then t.doc -> 'moves' else '[]'::jsonb end) v
                      where v ->> 'id' = m.about ->> 'id' limit 1)
                   else null end as key,
                 m.rating::int as rating
            from public.moments m
            join public.trips t on t.id = m.trip_id
           where m.author_id = $1 and m.rating between 1 and 5
             and jsonb_typeof(m.about) = 'object'
             and m.about ->> 'kind' in ('stay', 'move', 'event', 'place')
        ) x
       where x.key is not null
    $q$ into v_rows using p_user;

    select count(*)::int into v_reviews from jsonb_to_recordset(v_rows) as r(kind text, key text, rating int);

    select coalesce(jsonb_object_agg(g.key, jsonb_build_object('mean', g.mean, 'n', g.n)), '{}'::jsonb)
      into v_cat
      from (select r.key, round(avg(r.rating), 1) as mean, count(*)::int as n
              from jsonb_to_recordset(v_rows) as r(kind text, key text, rating int)
             where r.kind = 'event' group by r.key) g;
    select coalesce(jsonb_object_agg(g.key, jsonb_build_object('mean', g.mean, 'n', g.n)), '{}'::jsonb)
      into v_places
      from (select r.key, round(avg(r.rating), 1) as mean, count(*)::int as n
              from jsonb_to_recordset(v_rows) as r(kind text, key text, rating int)
             where r.kind = 'place' group by r.key) g;
    select coalesce(jsonb_agg(g.key order by g.mean desc, g.key), '[]'::jsonb) into v_likes
      from (select r.key, round(avg(r.rating), 1) as mean
              from jsonb_to_recordset(v_rows) as r(kind text, key text, rating int)
             where r.kind = 'event'
             group by r.key having count(*) >= 2 and round(avg(r.rating), 1) >= 4.0) g;
    select coalesce(jsonb_agg(g.key order by g.mean, g.key), '[]'::jsonb) into v_avoids
      from (select r.key, round(avg(r.rating), 1) as mean
              from jsonb_to_recordset(v_rows) as r(kind text, key text, rating int)
             where r.kind = 'event'
             group by r.key having count(*) >= 2 and round(avg(r.rating), 1) <= 2.5) g;

    v_out := jsonb_build_object('reviews', v_reviews, 'likes', v_likes, 'avoids', v_avoids,
                                'byCategory', v_cat, 'places', v_places, 'card', null, 'hide', '[]'::jsonb);
  end if;

  if to_regclass('public.taste_prefs') is not null then
    execute 'select case when card = ''{}''::jsonb then null else card end, to_jsonb(coalesce(hide, ''{}''::text[]))
               from public.taste_prefs where user_id = $1'
       into v_card, v_hide using p_user;
    v_out := v_out || jsonb_build_object('card', v_card, 'hide', coalesce(v_hide, '[]'::jsonb));
  end if;
  return v_out;
end $$;

-- Only the database owner (the role the edge function connects as) runs these.
revoke all on function sawk.loco_date(text) from public;
revoke all on function sawk.loco_tz(text) from public;
revoke all on function sawk.loco_my_trips(uuid) from public;
revoke all on function sawk.loco_home(uuid) from public;
revoke all on function sawk.loco_windows(uuid, date, date) from public;
revoke all on function sawk.loco_busy(uuid, date, date) from public;
revoke all on function sawk.loco_taste(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema sawk from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all functions in schema sawk from authenticated';
  end if;
end $$;
