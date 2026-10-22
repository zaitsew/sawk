import { assert, assertEquals } from "jsr:@std/assert@1";
import { hostAllowed, hostOf, INGEST_HOSTS } from "./hosts.ts";

Deno.test("allow-list: the listed host or a subdomain of it, nothing that merely looks like it", () => {
  for (
    const h of [
      "meetup.com",
      "www.meetup.com",
      "eventbrite.es",
      "www.eventbrite.es",
      "songkick.com",
      "www.songkick.com",
      "bandsintown.com",
      "www.bandsintown.com",
      "ticketmaster.es",
      "www.ticketmaster.es",
      "allevents.in",
      "app.ticketmaster.com",
      "WWW.MEETUP.COM",
      "meetup.com.",
    ]
  ) assert(hostAllowed(h), h);
  for (
    const h of [
      "evilmeetup.com",
      "meetup.com.evil.test",
      "meetup.co",
      "eventbrite.com",
      "ticketmaster.com",
      "www.ticketmaster.com",
      "localhost",
      "127.0.0.1",
      "ticketmaster.es.attacker.example",
      "attacker.test",
      "",
    ]
  ) assert(!hostAllowed(h), h);
  assertEquals(hostOf("https://www.meetup.com/x/events/ical/"), "www.meetup.com");
  assertEquals(hostOf("ticketmaster:city=Valencia"), null);
  assertEquals(INGEST_HOSTS.length, 7);
});
