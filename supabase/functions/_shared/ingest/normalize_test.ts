import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  categorize,
  cleanText,
  decodeEntities,
  finalizeEvents,
  fold,
  looksLikeAddress,
  mentionsFree,
  resolveUrl,
  sameCity,
} from "./normalize.ts";
import { NOW, source } from "./testing.ts";
import type { IngestEvent } from "./types.ts";

const ev = (over: Partial<IngestEvent> = {}): IngestEvent => ({
  title: "Jazz Night",
  startsAt: "2026-10-24T20:00:00Z",
  url: "https://x.test/jazz",
  ...over,
} as IngestEvent);

Deno.test("text: entities, tags, whitespace; fold drops accents", () => {
  assertEquals(decodeEntities("Caf&eacute; &amp; Jazz &#8211; &#x41;"), "Café & Jazz – A");
  assertEquals(cleanText("<p>Hello&nbsp;<b>world</b></p>\n\n\n<p>Bye</p>"), "Hello world\n\nBye");
  assertEquals(cleanText("x".repeat(50), 10).length <= 10, true);
  assertEquals(fold("¡Rosalía, EN Valencia!"), "rosalia en valencia");
  assertEquals([sameCity("València", "valencia"), sameCity("Madrid", "valencia"), sameCity(null, null)], [
    true,
    false,
    false,
  ]);
});

Deno.test("categories from words, in priority order", () => {
  assertEquals(categorize("Concierto de jazz en directo"), "music");
  assertEquals(categorize("Fallas 2027 festival"), "festival");
  assertEquals(categorize("Language exchange at the bar"), "meetup");
  assertEquals(categorize("Exposición de fotografía"), "art");
  assertEquals(categorize("Python meetup for developers"), "tech");
  assertEquals(categorize("Valencia Basket partido"), "sport");
  assertEquals(categorize("Noche en el club"), null); // "club" alone says nothing
  assertEquals(categorize(""), null);
});

Deno.test("free, addresses, urls", () => {
  assert(mentionsFree("Entrada libre hasta completar aforo"));
  assert(mentionsFree("Free entry before 11pm"));
  assert(!mentionsFree("Carefree afternoon"));
  assert(looksLikeAddress("Carrer de Baja, 28"));
  assert(looksLikeAddress("C/ Mayor 3"));
  assert(!looksLikeAddress("Jimmy Glass"));
  assertEquals(resolveUrl("/a?b=1", "https://x.test/p/q"), "https://x.test/a?b=1");
  assertEquals(resolveUrl("javascript:alert(1)", "https://x.test/"), null);
});

Deno.test("finalize: defaults from the source, a stable id, the category ladder", async () => {
  const src = source({ categories: ["meetup"], country: "ES" });
  const { events } = await finalizeEvents(
    [ev(), ev({ title: "Quiet evening", startsAt: "2026-10-25T20:00:00Z" })],
    src,
    NOW,
  );
  const [jazz, quiet] = events;
  assertEquals([jazz.city, jazz.country, jazz.tz], ["Valencia", "ES", "Europe/Madrid"]);
  assertEquals(jazz.category, "music");
  assertEquals(quiet.category, "meetup"); // the source's hint when the words say nothing
  assertEquals(quiet.isFree, null);
  assert(jazz.id.startsWith("ev_") || jazz.id.length > 8);
  const again = await finalizeEvents([ev()], src, NOW);
  assertEquals(again.events[0].id, jazz.id);
});

Deno.test("finalize: what is over or too far ahead is dropped; one bad event is not the batch", async () => {
  const src = source();
  const raw = [
    ev({ title: "Over", startsAt: "2026-10-22T20:00:00Z" }),
    ev({ title: "Still on", startsAt: "2026-10-22T20:00:00Z", endsAt: "2026-10-24T20:00:00Z" }),
    ev({ title: "Far", startsAt: "2028-01-01T20:00:00Z" }),
    ev({ title: "Today, later", startsAt: "2026-10-23T18:00:00Z" }),
    ev({ title: "", startsAt: "2026-10-24T20:00:00Z" }),
    ev({ title: "No url", url: "ftp://x" }),
    ev({ title: "Bad date", startsAt: "soon" }),
    ev({ title: "Backwards", startsAt: "2026-10-24T20:00:00Z", endsAt: "2026-10-24T10:00:00Z" }),
    ev({ title: "Backwards", startsAt: "2026-10-24T20:00:00Z" }), // same event again: kept once
  ];
  const { events, dropped } = await finalizeEvents(raw, src, NOW);
  assertEquals(events.map((e) => e.title), ["Still on", "Today, later", "Backwards"]);
  assertEquals(events[2].endsAt, null);
  assertEquals(dropped, 6);
});

Deno.test("finalize: free from price or words; prices that say paid", async () => {
  const { events } = await finalizeEvents(
    [
      ev({ title: "A", priceMin: 0, priceMax: 0 }),
      ev({ title: "B", description: "Entrada libre" }),
      ev({ title: "C", priceMin: 5, priceMax: 9, currency: "eur" }),
      ev({ title: "D", isFree: true, lat: 200, lon: 5 }),
    ],
    source(),
    NOW,
  );
  assertEquals(events.map((e) => e.isFree), [true, true, false, true]);
  assertEquals(events[2].currency, "EUR");
  assertEquals([events[3].lat, events[3].lon], [null, 5]); // an impossible latitude is not kept
});
