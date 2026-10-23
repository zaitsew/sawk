-- One key per city, whatever language it is written in. Loco stores cities in the
-- person's language ("Валенсия", "Гран-Канария"); sources and events use the local
-- or English name ("Valencia", "Las Palmas de Gran Canaria"). Comparing the written
-- names never matched them, so a trip window found no sources and no events.
--
-- sawk.city_key(name) folds the name (lowercase, no accents, punctuation as spaces)
-- and looks it up in sawk.city_aliases; an unknown name is its own folded key.
-- Events and sources keep the name as written and carry the key in `city_key`,
-- kept by a trigger. Adding an alias re-keys the rows it touches.

create table sawk.cities (
  key     text primary key,        -- sawk.city_fold(name); a name needs no alias row of its own
  name    text not null,           -- "Valencia": the name agents search with
  country text                     -- ISO 3166-1 alpha-2
);

create table sawk.city_aliases (
  alias text primary key,          -- sawk.city_fold(<a name as written>)
  key   text not null references sawk.cities (key) on delete cascade
);

alter table sawk.cities       enable row level security;
alter table sawk.city_aliases enable row level security;

create or replace function sawk.city_fold(p_name text)
returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(
    translate(replace(lower(coalesce(p_name, '')), 'ß', 'ss'),
      'áàâäãåāăąéèêëēėęěíìîïīįóòôöõøōőúùûüūůűñńçćčśšźżžýÿłđğışțșё',
      'aaaaaaaaaeeeeeeeeiiiiiioooooooouuuuuuunncccsszzzyyldgistsе'),
    '[[:space:][:punct:]]+', ' ', 'g'))
$$;

create or replace function sawk.city_key(p_name text)
returns text
language sql stable set search_path = '' as $$
  select coalesce(
    (select a.key from sawk.city_aliases a where a.alias = sawk.city_fold(p_name)),
    nullif(sawk.city_fold(p_name), ''))
$$;

-- The canonical name for a key, or null for a city the table does not know.
create or replace function sawk.city_name(p_key text)
returns text
language sql stable set search_path = '' as $$
  select c.name from sawk.cities c where c.key = p_key
$$;

alter table sawk.events  add column city_key text;
alter table sawk.sources add column city_key text;

create or replace function sawk.set_city_key()
returns trigger
language plpgsql set search_path = '' as $$
begin
  new.city_key := sawk.city_key(new.city);
  return new;
end $$;

create trigger events_city_key before insert or update of city on sawk.events
  for each row execute function sawk.set_city_key();
create trigger sources_city_key before insert or update of city on sawk.sources
  for each row execute function sawk.set_city_key();

-- An alias added, changed or removed: re-key the events and sources it moves.
-- Aliases change only in migrations; a row inserted concurrently with one keeps the old key
-- until its city is written again (`update ... set city_key = sawk.city_key(city)` re-keys all).
create or replace function sawk.rekey_cities()
returns trigger
language plpgsql set search_path = '' as $$
begin
  update sawk.events set city_key = sawk.city_key(city) where city_key is distinct from sawk.city_key(city);
  update sawk.sources set city_key = sawk.city_key(city) where city_key is distinct from sawk.city_key(city);
  return null;
end $$;

create trigger city_aliases_rekey after insert or update or delete on sawk.city_aliases
  for each statement execute function sawk.rekey_cities();

-- The seed: cities people travel to, with the names Loco and the sources write them in.
-- An island or a metro name points to the city whose sources cover it.
insert into sawk.cities (key, name, country)
select sawk.city_fold(c.name), c.name, c.country from (values
  ('Valencia', 'ES'),
  ('Las Palmas de Gran Canaria', 'ES'),
  ('Santa Cruz de Tenerife', 'ES'),
  ('Palma', 'ES'),
  ('Madrid', 'ES'),
  ('Barcelona', 'ES'),
  ('Seville', 'ES'),
  ('Malaga', 'ES'),
  ('Alicante', 'ES'),
  ('Bilbao', 'ES'),
  ('Granada', 'ES'),
  ('Lisbon', 'PT'),
  ('Porto', 'PT'),
  ('Paris', 'FR'),
  ('London', 'GB'),
  ('Rome', 'IT'),
  ('Milan', 'IT'),
  ('Florence', 'IT'),
  ('Venice', 'IT'),
  ('Naples', 'IT'),
  ('Berlin', 'DE'),
  ('Munich', 'DE'),
  ('Vienna', 'AT'),
  ('Prague', 'CZ'),
  ('Warsaw', 'PL'),
  ('Amsterdam', 'NL'),
  ('Athens', 'GR'),
  ('Istanbul', 'TR'),
  ('Belgrade', 'RS'),
  ('Tbilisi', 'GE'),
  ('Yerevan', 'AM'),
  ('Moscow', 'RU'),
  ('Saint Petersburg', 'RU'),
  ('Dubai', 'AE'),
  ('Shanghai', 'CN'),
  ('Tokyo', 'JP'),
  ('New York', 'US')
) as c (name, country)
on conflict (key) do nothing;

insert into sawk.city_aliases (alias, key)
select sawk.city_fold(a.alias), sawk.city_fold(a.name) from (values
  ('Valencia', 'València'), ('Valencia', 'Валенсия'),
  ('Las Palmas de Gran Canaria', 'Las Palmas'), ('Las Palmas de Gran Canaria', 'Gran Canaria'),
  ('Las Palmas de Gran Canaria', 'Гран-Канария'), ('Las Palmas de Gran Canaria', 'Лас-Пальмас'),
  ('Las Palmas de Gran Canaria', 'Лас-Пальмас-де-Гран-Канария'),
  ('Santa Cruz de Tenerife', 'Tenerife'), ('Santa Cruz de Tenerife', 'Тенерифе'),
  ('Santa Cruz de Tenerife', 'Санта-Крус-де-Тенерифе'),
  ('Palma', 'Palma de Mallorca'), ('Palma', 'Mallorca'), ('Palma', 'Majorca'), ('Palma', 'Пальма'),
  ('Palma', 'Пальма-де-Майорка'), ('Palma', 'Майорка'),
  ('Madrid', 'Мадрид'),
  ('Barcelona', 'Барселона'),
  ('Seville', 'Sevilla'), ('Seville', 'Севилья'),
  ('Malaga', 'Малага'),
  ('Alicante', 'Alacant'), ('Alicante', 'Аликанте'),
  ('Bilbao', 'Bilbo'), ('Bilbao', 'Бильбао'),
  ('Granada', 'Гранада'),
  ('Lisbon', 'Lisboa'), ('Lisbon', 'Лиссабон'),
  ('Porto', 'Oporto'), ('Porto', 'Порту'),
  ('Paris', 'Париж'),
  ('London', 'Londres'), ('London', 'Лондон'),
  ('Rome', 'Roma'), ('Rome', 'Рим'),
  ('Milan', 'Milano'), ('Milan', 'Милан'),
  ('Florence', 'Firenze'), ('Florence', 'Флоренция'),
  ('Venice', 'Venezia'), ('Venice', 'Венеция'),
  ('Naples', 'Napoli'), ('Naples', 'Неаполь'),
  ('Berlin', 'Берлин'),
  ('Munich', 'München'), ('Munich', 'Muenchen'), ('Munich', 'Мюнхен'),
  ('Vienna', 'Wien'), ('Vienna', 'Вена'),
  ('Prague', 'Praha'), ('Prague', 'Прага'),
  ('Warsaw', 'Warszawa'), ('Warsaw', 'Варшава'),
  ('Amsterdam', 'Амстердам'),
  ('Athens', 'Athina'), ('Athens', 'Афины'),
  ('Istanbul', 'İstanbul'), ('Istanbul', 'Стамбул'),
  ('Belgrade', 'Beograd'), ('Belgrade', 'Белград'),
  ('Tbilisi', 'Тбилиси'),
  ('Yerevan', 'Ереван'),
  ('Moscow', 'Москва'),
  ('Saint Petersburg', 'St Petersburg'), ('Saint Petersburg', 'St. Petersburg'),
  ('Saint Petersburg', 'Санкт-Петербург'), ('Saint Petersburg', 'Петербург'),
  ('Dubai', 'Дубай'),
  ('Shanghai', 'Шанхай'), ('Shanghai', '上海'),
  ('Tokyo', 'Токио'), ('Tokyo', '東京'),
  ('New York', 'New York City'), ('New York', 'NYC'), ('New York', 'Нью-Йорк')
) as a (name, alias)
on conflict (alias) do nothing;

update sawk.events  set city_key = sawk.city_key(city);
update sawk.sources set city_key = sawk.city_key(city);
alter table sawk.events  alter column city_key set not null;
alter table sawk.sources alter column city_key set not null;

create index events_city_key_time on sawk.events (city_key, starts_at);
create index sources_city_key on sawk.sources (city_key) where active;

revoke all on function sawk.city_fold(text) from public;
revoke all on function sawk.city_key(text) from public;
revoke all on function sawk.city_name(text) from public;
revoke all on function sawk.set_city_key() from public;
revoke all on function sawk.rekey_cities() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on sawk.cities, sawk.city_aliases from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on sawk.cities, sawk.city_aliases from authenticated';
  end if;
end $$;
