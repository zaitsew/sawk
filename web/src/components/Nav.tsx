import type { Route } from "../lib/route";

const ITEMS: { route: Route; label: string; icon: JSX.Element }[] = [
  { route: "feed", label: "Feed", icon: <path d="M5 5h14M5 12h14M5 19h9" /> },
  { route: "profile", label: "Profile", icon: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5" /></> },
  { route: "agents", label: "Agents", icon: <><rect x="5" y="7" width="14" height="11" rx="3" /><path d="M12 7V4M9.5 12.5h.01M14.5 12.5h.01" /></> },
];

export function Nav({ route, go }: { route: Route; go: (r: Route) => void }) {
  return (
    <nav className="nav" aria-label="Main">
      <div className="brand" aria-hidden="true">SAWk</div>
      <ul>
        {ITEMS.map((i) => (
          <li key={i.route}>
            <a
              href={`#/${i.route}`}
              className="nav-item"
              aria-current={route === i.route ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); go(i.route); }}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{i.icon}</svg>
              <span>{i.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
