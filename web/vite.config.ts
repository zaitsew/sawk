import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Stamps `dist/sw.js` with an id derived from the built index.html and the list of built
 *  assets, so a new build is a new worker, the shell works offline from the first visit,
 *  and the old caches are dropped on activate. */
function serviceWorkerStamp(): Plugin {
  let outDir = "dist";
  return {
    name: "sawk-sw-stamp",
    apply: "build",
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const sw = path.join(outDir, "sw.js");
      const html = readFileSync(path.join(outDir, "index.html"), "utf8");
      const id = createHash("sha256").update(html).digest("hex").slice(0, 12);
      const assets = readdirSync(path.join(outDir, "assets")).map((f) => `./assets/${f}`);
      writeFileSync(
        sw,
        readFileSync(sw, "utf8").replace("__BUILD_ID__", id).replace("/*PRECACHE*/[]/*END*/", JSON.stringify(assets)),
      );
    },
  };
}

// Served from https://zaitsew.github.io/sawk/ — the one place the base path is written.
export default defineConfig({
  base: "/sawk/",
  plugins: [react(), serviceWorkerStamp()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  // The suite runs in UTC wherever it is run; a test that needs another zone names it.
  test: { env: { TZ: "UTC" }, environment: "node" },
});
