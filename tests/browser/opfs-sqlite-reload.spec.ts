import { expect, test } from "@playwright/test";

/**
 * Real OPFS, real SQLite-WASM, real worker, real page death.
 *
 * The engine-conformance run uses a `:memory:` database, so its reopen
 * property proves data survives dropping the ENGINE — not the PROCESS. Only
 * a real browser can prove the latter, and this is the lane that does it.
 *
 * The load-bearing assertion is `persistent`. When OPFS is unavailable the
 * worker quietly falls back to an in-memory database (`src/sqlite-worker.ts`)
 * and keeps answering every call successfully. Without checking that flag, a
 * misconfigured run would report a confusing "nothing survived" instead of
 * naming the actual cause, and an in-memory pass would be indistinguishable
 * from real durability.
 */

async function bootFixture(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => !!window.__cdb, null, { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await bootFixture(page);
});

test("entities written to real OPFS SQLite survive a page reload", async ({ page }) => {
  const seeded = await page.evaluate(() => window.__cdb.sqlite.seed());

  // Anti-vacuity: if this is false the engine fell back to memory and every
  // assertion below would be measuring the wrong thing.
  expect(seeded.persistent, "engine must be on real OPFS, not the in-memory fallback").toBe(true);
  expect(seeded.rowsOnDisk).toBe(2);

  // Process death. The worker is terminated, the page is torn down, and the
  // SQLite file in OPFS is all that remains.
  await page.reload();
  await bootFixture(page);

  const after = await page.evaluate(() => window.__cdb.sqlite.verify());

  expect(after.persistent).toBe(true);
  expect(after.ids).toEqual(["1", "2"]);
  expect(after.title).toBe("alpha");
  expect(after.count).toBe(42);
});

test("OPFS SQLite JSON-encodes dates — the documented engine divergence", async ({ page }) => {
  const expected = await page.evaluate(() => window.__cdb.expectedWhenIso);
  const seeded = await page.evaluate(() => window.__cdb.sqlite.seed());
  expect(seeded.persistent).toBe(true);

  await page.reload();
  await bootFixture(page);

  const after = await page.evaluate(() => window.__cdb.sqlite.verify());

  // This engine serializes with `JSON.stringify`, so a Date returns as an ISO
  // string while `idbEngine` returns a Date. That divergence is CONTRACT, not
  // a defect — `src/types.ts` states it explicitly, and entities are told to
  // stick to JSON-safe fields for engine portability. Pinning it here means a
  // change to the persisted encoding has to be a deliberate act.
  expect(after.whenType).toBe("string");
  expect(after.whenIso).toBe(expected);
});

/**
 * Negative control — see the twin in `idb-reload.spec.ts`. OPFS is scoped to
 * the browser profile, and Playwright gives each test a fresh one, so this
 * must observe an empty database. It also proves `persistent` is not a rubber
 * stamp: it reads true here, where there is nothing to find.
 */
test("a fresh profile reads nothing — the suite can observe absence", async ({ page }) => {
  const after = await page.evaluate(() => window.__cdb.sqlite.verify());

  expect(after.persistent).toBe(true);
  expect(after.ids).toEqual([]);
  expect(after.title).toBeUndefined();
});
