# Query patterns

Build 8 to 12 queries per run from the profile, not from a fixed list. Local-language month names and
weekday words matter: listing pages are written in them.

## Shape

`<like or category> <city> <day or month> <year>`

| window | like | queries |
|---|---|---|
| Valencia, 2026-10-24 to 11-06 | jazz | `jazz Valencia 24 octubre 2026`, `concierto jazz Valencia noviembre 2026`, `jazz Valencia this weekend` |
| Valencia | exhibitions | `exposición Valencia noviembre 2026`, `exposiciones Valencia agenda semana`, `museum exhibition Valencia November 2026` |
| Valencia | tech | `tech meetup Valencia`, `meetup Valencia noviembre 2026`, `lu.ma Valencia` |
| Tokyo, 2026-11-10 to 11-16 | design | `東京 デザイン 展覧会 11月 2026`, `Tokyo design exhibition November 2026` |

## Where to look

- Aggregators with dates and times on the page: Luma (`lu.ma`), Meetup, Eventbrite, Resident Advisor
  (clubs and electronic music), Songkick or Bandsintown (gigs), Fever, Time Out city agenda.
- The venue's own programme page: highest trust; the page states the time.
- The city's official culture agenda (a `cultura` or `agenda` page of the city hall).
- The person's `sources` of kind `web` for that city.

## Skip

Articles ("10 things to do"), ticket resellers with no date on the page, social posts without a date and
time, events whose date is a range with no start time.
