import { expect, test } from "@playwright/test";

/**
 * Real IndexedDB, real page death, real cold boot.
 *
 * The fast suite exercises this engine against an in-process stand-in, which
 * can only ever prove the stand-in. Here the browser's own IndexedDB does the
 * work and the page is genuinely reloaded between write and read, so a pass
 * means data survived process death — the one thing a local-first database
 * exists to guarantee.
 */

async function bootFixture(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => !!window.__cdb, null, { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await bootFixture(page);
});

test("entities written to real IndexedDB survive a page reload", async ({ page }) => {
  const seeded = await page.evaluate(() => window.__cdb.idb.seed());
  expect(seeded.rowsOnDisk).toBe(2);

  // Process death. Everything in memory is gone; only storage carries over.
  await page.reload();
  await bootFixture(page);

  const after = await page.evaluate(() => window.__cdb.idb.verify());

  expect(after.ids).toEqual(["1", "2"]);
  expect(after.title).toBe("alpha");
  expect(after.count).toBe(42);
});

test("IndexedDB preserves structured-clone fidelity across a reload", async ({ page }) => {
  const expected = await page.evaluate(() => window.__cdb.expectedWhenIso);
  await page.evaluate(() => window.__cdb.idb.seed());

  await page.reload();
  await bootFixture(page);

  const after = await page.evaluate(() => window.__cdb.idb.verify());

  // IndexedDB structured-clones, so a Date comes back AS a Date — not as an
  // ISO string. This is the documented engine contract (`src/types.ts`), and
  // it is exactly where `sqliteEngine` legitimately differs.
  expect(after.whenType).toBe("Date");
  expect(after.whenIso).toBe(expected);
});

/**
 * Negative control. A durability suite that cannot read EMPTY proves nothing:
 * were `verify()` silently returning stale in-memory state, every assertion
 * above would still pass. Playwright gives each test a fresh browser context,
 * so this one starts with untouched storage and must find nothing.
 */
test("a fresh profile reads nothing — the suite can observe absence", async ({ page }) => {
  const after = await page.evaluate(() => window.__cdb.idb.verify());

  expect(after.ids).toEqual([]);
  expect(after.title).toBeUndefined();
});
