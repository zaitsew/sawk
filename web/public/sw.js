// The app shell only. API answers are never cached here: the feed is personal and
// the app keeps its own last answer (see src/lib/cache.ts). Every URL resolves
// against the worker's own location, which is the base path.
const BUILD = "__BUILD_ID__";
const SHELL = `sawk-shell-${BUILD}`;
const ASSETS = "sawk-assets";
const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./favicon.svg"];
// Filled in by vite.config.ts with this build's hashed files.
const PRECACHE = /*PRECACHE*/[]/*END*/;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES.map((f) => new Request(f, { cache: "reload" })));
    const assets = await caches.open(ASSETS);
    for (const f of PRECACHE) if (!(await assets.match(f))) await assets.add(f);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== SHELL && k !== ASSETS) await caches.delete(k);
    }
    // Drop hashed files this build no longer has.
    if (PRECACHE.length) {
      const keep = new Set(PRECACHE.map((f) => new URL(f, self.location.href).pathname));
      const assets = await caches.open(ASSETS);
      for (const req of await assets.keys()) if (!keep.has(new URL(req.url).pathname)) await assets.delete(req);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API, images, Supabase: network only

  // Pages: network first, the cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const shell = await caches.open(SHELL);
        shell.put(new URL("./index.html", self.location.href), res.clone());
        return res;
      } catch {
        const shell = await caches.open(SHELL);
        return (await shell.match(new URL("./index.html", self.location.href))) || Response.error();
      }
    })());
    return;
  }

  // Hashed build files: cache first.
  if (url.pathname.includes("/assets/")) {
    e.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
  }
});
