-- SAWk 0003 — the owner's starting sources: Valencia, Spain.
--
-- Every `ics` and `jsonld` row below was fetched and parsed by the ingest
-- adapters on 2026-10-23 and returned upcoming events; docs/SOURCES.md has the
-- counts. `web` rows are agent-only: pages worth reading that carry no
-- machine-readable events. Adding a city is adding rows (`sawk_add_source`).
--
-- Safe to re-run: (kind, url) is unique and a repeat does nothing.

insert into sawk.sources (city, country, kind, url, label, categories) values
  -- Meetup groups: each group publishes an iCalendar feed.
  ('Valencia', 'ES', 'ics', 'https://www.meetup.com/awakatech/events/ical/', 'Meetup · Awakatech', '{tech,meetup}'),
  ('Valencia', 'ES', 'ics', 'https://www.meetup.com/bookloversvalencia/events/ical/', 'Meetup · Book Lovers Valencia', '{talk,meetup}'),
  ('Valencia', 'ES', 'ics', 'https://www.meetup.com/digital-nomads-founders-valencia/events/ical/', 'Meetup · Valencia Nomads Club', '{meetup}'),
  ('Valencia', 'ES', 'ics', 'https://www.meetup.com/encuentros-filosoficos/events/ical/', 'Meetup · Encuentros filosóficos', '{talk}'),
  ('Valencia', 'ES', 'ics', 'https://www.meetup.com/language-exchanges-events/events/ical/', 'Meetup · Language Exchange Club', '{meetup}'),
  ('Valencia', 'ES', 'ics', 'https://www.meetup.com/thoughtful-connections-valencia/events/ical/', 'Meetup · Introvert''s Social Club Valencia', '{meetup}'),
  ('Valencia', 'ES', 'ics', 'https://www.meetup.com/valencia-international-community/events/ical/', 'Meetup · Valencia International Community', '{meetup}'),
  ('Valencia', 'ES', 'ics', 'https://www.meetup.com/valencia-walks-talks/events/ical/', 'Meetup · Valencia Walks & Talks', '{outdoor,talk}'),

  -- Pages with schema.org Event JSON-LD.
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/events/', 'Eventbrite · Valencia', '{}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/music--events/', 'Eventbrite · Valencia · music', '{music}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/nightlife--events/', 'Eventbrite · Valencia · nightlife', '{nightlife}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/performing-and-visual-arts--events/', 'Eventbrite · Valencia · arts', '{art,theatre}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/food-and-drink--events/', 'Eventbrite · Valencia · food and drink', '{food}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/science-and-tech--events/', 'Eventbrite · Valencia · science and tech', '{tech}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/business--events/', 'Eventbrite · Valencia · business', '{meetup}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/sports-and-fitness--events/', 'Eventbrite · Valencia · sports', '{sport}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/community--events/', 'Eventbrite · Valencia · community', '{meetup}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/family-and-education--events/', 'Eventbrite · Valencia · family', '{family}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/film-and-media--events/', 'Eventbrite · Valencia · film', '{film}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.eventbrite.es/d/spain--valencia/free--events/', 'Eventbrite · Valencia · free', '{}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.songkick.com/metro-areas/28802-spain-valencia', 'Songkick · Valencia concerts', '{music}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.songkick.com/metro-areas/28802-spain-valencia?page=2', 'Songkick · Valencia concerts (page 2)', '{music}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.bandsintown.com/c/valencia-spain', 'Bandsintown · Valencia', '{music}'),
  ('Valencia', 'ES', 'jsonld', 'https://www.ticketmaster.es/discover/valencia', 'Ticketmaster.es · Valencia', '{music}'),
  ('Valencia', 'ES', 'jsonld', 'https://allevents.in/valencia', 'AllEvents · Valencia', '{}'),

  -- Ticketmaster Discovery API: needs TICKETMASTER_API_KEY, skipped without it.
  ('Valencia', 'ES', 'ticketmaster', 'ticketmaster:city=Valencia&countryCode=ES', 'Ticketmaster API · Valencia', '{music,sport,theatre}'),

  -- Read by agents only (no machine-readable events on the page).
  ('Valencia', 'ES', 'web', 'https://www.visitvalencia.com/agenda-valencia', 'Visit València · agenda', '{}'),
  ('Valencia', 'ES', 'web', 'https://valenciaplaza.com/culturplaza/', 'Culturplaza · culture and entertainment', '{art,theatre,music,film}'),
  ('Valencia', 'ES', 'web', 'https://ivam.es/es/exposiciones/', 'IVAM · exhibitions', '{art}'),
  ('Valencia', 'ES', 'web', 'https://www.roigarena.com/es/eventos/', 'Roig Arena · events', '{music,sport}'),
  ('Valencia', 'ES', 'web', 'https://16toneladas.com/', '16 Toneladas · programme', '{music,nightlife}'),
  ('Valencia', 'ES', 'web', 'https://larambleta.com/', 'La Rambleta · programme', '{theatre,family,music}'),
  ('Valencia', 'ES', 'web', 'https://bombasgens.com/', 'Bombas Gens · exhibitions and events', '{art}'),
  ('Valencia', 'ES', 'web', 'https://mercadocolon.es/eventos/', 'Mercado de Colón · events', '{market,food}'),
  ('Valencia', 'ES', 'web', 'https://www.valenciabasket.com/', 'Valencia Basket · fixtures', '{sport}')
on conflict (kind, url) do nothing;
