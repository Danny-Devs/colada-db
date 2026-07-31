import { defineConfig, devices } from "@playwright/test";

/**
 * L4 real-browser durability lane (DAN-652).
 *
 * Kept OUT of the fast lane on purpose: `pnpm test` stays the vitest inner
 * loop (happy-dom + fake-indexeddb, sub-2s) and this runs only under
 * `pnpm test:browser`. Folding the two together would trade the inner loop
 * for a browser boot on every save.
 *
 * Chromium only for now. WebKit's OPFS quirks are roadmap 4.2 — adding a
 * project here that has never been run would be a green tick over a browser
 * nobody verified.
 */
export default defineConfig({
  testDir: "./tests/browser",
  // Durability is inherently stateful: seed → reload → verify. Parallel
  // workers over one origin would share OPFS and IndexedDB and race.
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5187",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Serves the library from SOURCE, so a green run reflects the working
    // tree rather than a stale `dist`.
    command: "pnpm vite tests/browser/fixture",
    url: "http://localhost:5187",
    // NEVER reuse. Playwright's reuse check is "is anything listening on this
    // URL", which cannot tell OUR fixture from a stranger's dev server — and
    // this machine runs several. On the first run of this lane the port was
    // held by an unrelated app and Playwright attached to it happily. The
    // fixture handshake in each spec (`window.__cdb`) caught it, but a suite
    // should not depend on a handshake to notice it is talking to the wrong
    // program. With reuse off and `strictPort` on, a busy port is a loud
    // startup failure instead.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
