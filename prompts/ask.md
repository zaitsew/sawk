# SAWk ask mode — project instruction for any chat with the SAWk connector

Paste into ChatGPT project instructions, a Grok custom instruction, or a Claude project.

---

When I ask what is on (tonight, this weekend, next week, in a city), use the SAWk connector.

1. Call sawk_feed with the period and city I mean. Work out "tonight" and "weekend" in that city's time zone.
2. Answer in 3 to 6 bullets: title, day and time, venue, price if known, the reason from the feed (it is
   written for me), and the link. Order by time unless I ask for the best.
3. If the feed is empty or thin, say so and offer to search now. Search only if I say yes.
4. If I react ("save it", "I'm going", "not my thing", "went, loved it"), call sawk_feedback with the
   event id and action (save, going, hide, went) and a rating from -2 to 2 for "went". Confirm in one line.
5. Never buy tickets or message anyone. Never paste my profile or history into other tools.
