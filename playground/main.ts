/**
 * DAN-578 DoD playground — real browser, real OPFS SQLite.
 *
 * Seeds 10,000 entities, references 1,000 of them across 20 scope
 * manifests, then proves in-page:
 *   B. manifest-mode boot hydrates EXACTLY the referenced 1,000
 *   B2. (context) full "all"-mode boot hydrates all 10,000 — timing shown
 *   C. evict (removeManifest + gc sweep) → hydrateScope re-hydrates via loadMany
 *   D. preload() warms a scope ahead of use
 *
 * Results render as PASS/FAIL rows and publish to window.__RESULTS__ /
 * #status.done-pass|done-fail for the driving agent.
 */
import { createEntityStore, enablePersistence, sqliteEngine } from "../src/index";
import type { EntityKey, PersistenceHandle } from "../src/index";

const TOTAL = 10_000;
const SCOPES = 20;
const PER_SCOPE = 50;
const REFERENCED = SCOPES * PER_SCOPE; // 1,000

const statusEl = document.getElementById("status")!;
const resultsEl = document.getElementById("results")!;
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
(window as unknown as { __RESULTS__: typeof results }).__RESULTS__ = results;

function report(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  const row = document.createElement("div");
  row.className = `row ${pass ? "pass" : "fail"}`;
  row.innerHTML = `<span class="name">${pass ? "✅" : "❌"} ${name}</span>\n<span class="detail">${detail}</span>`;
  resultsEl.appendChild(row);
}

function status(text: string): void {
  statusEl.textContent = text;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEngine() {
  return sqliteEngine({
    worker: () => new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" }),
  });
}

function scopeKeys(scope: number): EntityKey[] {
  return Array.from(
    { length: PER_SCOPE },
    (_, j) => `item:${scope * PER_SCOPE + j}` as EntityKey,
  );
}

async function phaseA_seed(): Promise<void> {
  status("Phase A — seeding 10,000 entities…");
  const engine = makeEngine();
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 50 });
  await handle.ready;

  const persistent = (engine as { persistent: boolean | null }).persistent;
  report("A0 · OPFS is real", persistent === true, `engine.persistent = ${persistent} (must be true — otherwise this run proves nothing durable)`);

  // Idempotent re-run: wipe previous state (entities via clear, manifests explicitly)
  for (let s = 0; s < SCOPES; s++) handle.removeManifest(`scope-${s}`);
  store.clear();
  await handle.flush();

  const t0 = performance.now();
  for (let i = 0; i < TOTAL; i++) {
    store.set("item", String(i), { id: String(i), title: `Item ${i}`, bucket: i % 97 });
  }
  for (let s = 0; s < SCOPES; s++) {
    handle.setManifest(`scope-${s}`, scopeKeys(s));
  }
  await handle.flush();
  const ms = Math.round(performance.now() - t0);

  const rows = await engine.loadAll();
  const entityRows = rows.filter((r) => !r.key.startsWith("__cdb_manifest__:")).length;
  const manifestRows = rows.length - entityRows;
  report(
    "A · seed 10,000 + 20 manifests",
    entityRows === TOTAL && manifestRows === SCOPES + 1,
    `${entityRows} entity rows, ${manifestRows} manifest rows (20 scopes + index) — written in ${ms}ms`,
  );

  handle.dispose();
  await tick(100);
}

async function phaseB_manifestBoot(): Promise<{
  store: ReturnType<typeof createEntityStore>;
  handle: PersistenceHandle;
}> {
  status("Phase B — manifest-mode cold boot…");
  const store = createEntityStore();
  let hydrated = 0;
  store.subscribe((e) => {
    if (e.origin === "hydration") hydrated++;
  });

  const t0 = performance.now();
  const handle = enablePersistence(store, {
    engine: makeEngine(),
    hydration: "manifest",
    writeDebounce: 50,
  });
  await handle.ready;
  const ms = Math.round(performance.now() - t0);

  const coldSpot = !store.has("item", String(TOTAL - 1)); // item:9999 unreferenced
  report(
    "B · manifest boot hydrates EXACTLY the referenced set",
    hydrated === REFERENCED && coldSpot,
    `hydrated ${hydrated}/${TOTAL} durable (expected ${REFERENCED}); item:9999 cold=${coldSpot}; boot ${ms}ms`,
  );
  const survivors = store.gc();
  report(
    "B1 · boot hydration is retained (no residency ratchet)",
    survivors.length === 0,
    `gc() immediately after boot evicted ${survivors.length} (expected 0 — every hydrated key is scope-retained)`,
  );
  return { store, handle };
}

async function phaseB2_fullBootTiming(): Promise<void> {
  status("Phase B2 — full 'all'-mode boot for comparison…");
  const store = createEntityStore();
  let hydrated = 0;
  store.subscribe((e) => {
    if (e.origin === "hydration") hydrated++;
  });
  const t0 = performance.now();
  const handle = enablePersistence(store, { engine: makeEngine(), writeDebounce: 50 });
  await handle.ready;
  const ms = Math.round(performance.now() - t0);
  report(
    "B2 · (context) legacy full boot hydrates all rows",
    hydrated === TOTAL,
    `hydrated ${hydrated}/${TOTAL} in ${ms}ms — the projection-vs-DB gap manifest mode closes`,
  );
  handle.dispose();
  await tick(100);
}

async function phaseC_evictRehydrate(
  store: ReturnType<typeof createEntityStore>,
  handle: PersistenceHandle,
): Promise<void> {
  status("Phase C — evict scope-0, re-hydrate via loadMany…");
  handle.removeManifest("scope-0");
  await tick(200); // debounced gc sweep

  const evicted = !store.has("item", "0") && !store.has("item", "49");
  const sharedUntouched = store.has("item", "50"); // scope-1 territory

  handle.setManifest("scope-0", scopeKeys(0)); // the scope remounts
  const hydrated = await handle.hydrateScope("scope-0");
  const back = store.has("item", "0") && store.has("item", "49");

  report(
    "C · removeManifest sweeps; hydrateScope pages back in",
    evicted && sharedUntouched && hydrated === PER_SCOPE && back,
    `evicted=${evicted}, other scopes untouched=${sharedUntouched}, re-hydrated ${hydrated}/${PER_SCOPE} via loadMany, resident again=${back}`,
  );
}

async function phaseD_preload(
  store: ReturnType<typeof createEntityStore>,
  handle: PersistenceHandle,
): Promise<void> {
  status("Phase D — preload warms ahead of use…");
  handle.removeManifest("scope-1");
  await tick(200);
  const cold = !store.has("item", "50");

  handle.setManifest("scope-1", scopeKeys(1));
  const warmed = await handle.preload(["scope-1"]);
  report(
    "D · preload(['scope-1']) warms the scope pre-mount",
    cold && warmed === PER_SCOPE && store.has("item", "50"),
    `cold before=${cold}, preload hydrated ${warmed}/${PER_SCOPE}, resident after=${store.has("item", "50")}`,
  );
}

async function main(): Promise<void> {
  try {
    // Sessions are STRICTLY sequential: opfs-sahpool is single-connection
    // (ADR-003 — multi-tab arrives with Phase 1 leader election), so every
    // phase disposes its handle before the next engine opens.
    await phaseA_seed();
    await phaseB2_fullBootTiming();
    const { store, handle } = await phaseB_manifestBoot();
    await phaseC_evictRehydrate(store, handle);
    await phaseD_preload(store, handle);
    handle.dispose();
  } catch (err) {
    report("UNCAUGHT", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  const failed = results.filter((r) => !r.pass).length;
  statusEl.className = failed === 0 ? "done-pass" : "done-fail";
  status(failed === 0 ? `DONE — ALL ${results.length} CHECKS PASS` : `DONE — ${failed} FAILED`);
}

void main();
