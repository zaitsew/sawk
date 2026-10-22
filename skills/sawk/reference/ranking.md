# Ranking rubric

Rank every candidate in every window. Score is 0..1, reason is one sentence.

## Scale

| score | meaning | typical case |
|---|---|---|
| 0.90 to 1.00 | made for them | matches a strong like, matches something they rated high, and they are free |
| 0.70 to 0.89 | good fit | matches a like or a note; no conflict |
| 0.50 to 0.69 | plausible | adjacent to a like; or a good event on a slightly awkward day |
| 0.30 to 0.49 | unlikely | no tie to the profile, or a mild conflict |
| 0.00 to 0.29 | conflicts | an avoid, a busy day, over the price cap, wrong language when it matters |

Spread the scores. If everything is 0.6 to 0.8 the ranking says nothing.

## Adjustments, in this order

1. **Avoids**: match means below 0.3. No exceptions.
2. **Schedule**: `busy` day minus 0.3; travel day (arrival or departure) minus 0.2; a late night the
   evening before an early departure minus 0.2.
3. **History**: venue or category the person hid minus 0.2; same artist or series they went to or rated
   1 or 2 (Loco's -2..2 scale) plus 0.15; things they saved plus 0.1 for close matches.
4. **Price**: above the price cap minus 0.3. Free events are not better by being free.
5. **Language**: an event in a language not in `profile.langs` minus 0.2 unless the category does not
   depend on language (music, dance, exhibitions).
6. **Diversity**: within one day, order by score; from the second event of the same category, minus
   0.1 each. Never let more events than `profile.max_per_day` stay at 0.7 or above on one day.

## Reasons

Second person, at most 200 characters, one sentence, specific.

| good | bad |
|---|---|
| You loved the Palau's chamber nights; this is the same quartet, and you're free that evening. | Great concert! |
| Matches your note "small rooms"; 60 seats, €12, a 10-minute walk from your stay. | Popular event in Valencia. |
| Lower: clashes with your flight to Lisbon the next morning. | Not a good fit. |
| Free exhibition on the day you have nothing planned; your hidden list has no museums. | Exhibition. |

State the downside when the score is low, so the person can see why it sits there.
