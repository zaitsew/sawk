// The only hosts the daily ingest fetches. Source rows are shared and anyone
// (or any agent) can add one, so the job reads from this list, not from
// whatever a row says. DNS rebinding cannot send a listed host's name to a
// private address without the operator of that host cooperating.
//
// A source on another host is skipped, not failed: agents can still read the
// page themselves. To add a host, add its registrable domain here and to the
// table in docs/SOURCES.md. A listed domain covers its subdomains (www.).

export const INGEST_HOSTS: readonly string[] = [
  "meetup.com",
  "eventbrite.es",
  "songkick.com",
  "bandsintown.com",
  "ticketmaster.es",
  "allevents.in",
  "app.ticketmaster.com",
];

export const NOT_ALLOWED = "host not on the ingest allow-list (agents can still read it)";

/** The exact host or a subdomain of a listed domain. "evilmeetup.com" and "meetup.com.evil.test" do not match. */
export function hostAllowed(host: string, list: readonly string[] = INGEST_HOSTS): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

/** The host of a source URL, or null when it is not a URL. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
