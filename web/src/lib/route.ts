import { useEffect, useState } from "react";

export type Route = "feed" | "profile" | "agents";
export const ROUTES: Route[] = ["feed", "profile", "agents"];

function read(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  return (ROUTES as string[]).includes(h) ? (h as Route) : "feed";
}

/** Hash routing: GitHub Pages serves one file, so paths would 404 on reload. */
export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (r) => { location.hash = `#/${r}`; }];
}
