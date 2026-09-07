import { bench, describe } from "vitest";
import { effect } from "@vue/reactivity";
import { createEntityStore } from "../src/store";
import { denormalize, normalize, writeEntitiesToStore } from "../src/normalize";
import { entityDefs, feedPayload, userRows } from "./fixtures";

/**
 * TIMING BENCHMARKS — reported with median and spread, never gating CI.
 * The deterministic counterpart is `src/perf-pins.spec.ts`, which asserts
 * recompute counts and DOES gate CI. See bench/README.md.
 *
 * Every group below pairs the measured path with a BASELINE measured on the
 * same data in the same run. A figure without a baseline beside it is
 * decoration: it tells you the machine was fast, not that the code was.
 */

// ── 1. Write path: batched vs one-at-a-time, under a live projection ────────
//
// BASELINE: the same 1000 entities written with individual set() calls, which
// is what a naive integration does. The gap is the cost of the type-projection
// rebuilding once per write instead of once per batch.
describe("write 1000 entities with a live getByType subscriber", () => {
  const rows = userRows(1000);

  bench("setMany — one batch", () => {
    const store = createEntityStore();
    const view = store.getByType("User");
    effect(() => void view.value.length);
    store.setMany(rows);
  });

  bench("BASELINE set() — one at a time", () => {
    const store = createEntityStore();
    const view = store.getByType("User");
    effect(() => void view.value.length);
    for (const r of rows) store.set(r.entityType, r.id, r.data);
  });
});

// ── 2. Normalization throughput ─────────────────────────────────────────────
//
// BASELINE: structuredClone of the identical payload. That is the floor cost of
// merely touching every field once, so the ratio says what normalization costs
// ABOVE simply walking the data — which is the honest question.
describe("normalize a 50-post feed (50 posts x 10 comments = 575 entities)", () => {
  const payload = feedPayload(50, 10);

  bench("normalize()", () => {
    normalize(payload, entityDefs, "id");
  });

  bench("BASELINE structuredClone() — walk the same data, extract nothing", () => {
    structuredClone(payload);
  });
});

// ── 3. Normalize + write, the full ingest path ──────────────────────────────
describe("full ingest: normalize + writeEntitiesToStore (575 entities)", () => {
  const payload = feedPayload(50, 10);

  bench("normalize + writeEntitiesToStore", () => {
    const store = createEntityStore();
    const { entities } = normalize(payload, entityDefs, "id");
    writeEntitiesToStore(entities, entityDefs, store);
  });
});

// ── 4. Read path: the denormalize cache, measured against itself ───────────
//
// An earlier draft of this file compared `store.get()` against `denormalize()`
// and reported an 8500x gap. That number was DELETED as a strawman: a Map
// lookup and a full 575-entity tree rebuild are not two ways to do one task,
// and nobody re-derives a whole response to read one field. It flattered the
// library and told a reader nothing true.
//
// The honest question about the read path is what `denormalize()`'s optional
// entity cache actually buys, so that is what is measured — the same function,
// on the same graph, with and without it.
describe("denormalize a 575-entity response", () => {
  const payload = feedPayload(50, 10);
  const store = createEntityStore();
  const { normalized, entities } = normalize(payload, entityDefs, "id");
  writeEntitiesToStore(entities, entityDefs, store);

  bench("denormalize() — no cache", () => {
    denormalize(normalized, store);
  });

  bench("denormalize() — with entity cache", () => {
    denormalize(normalized, store, new Map());
  });
});

// ── 5. THE PRODUCT CLAIM: update fan-out ────────────────────────────────────
//
// "One copy — every view holding it sees the change."
//
// Setup: 40 cached query results, each nesting the SAME author entity.
// Update that author's name once; measure ONLY the update.
//
//   normalized -> one store.set(); every view already points at the shared ref
//   BASELINE   -> a naive per-query response cache must find and patch every
//                 embedded copy, because each response holds its own object
//
// 🛑 Both graphs are built ONCE, outside the timed region. An earlier draft
// constructed 40 payloads inside the naive arm and one inside the normalized
// arm, so it was largely timing object allocation and reported a ratio that
// meant nothing. Arms that do not share their setup are measuring the setup.
//
// The name is varied per iteration so neither arm can short-circuit: the store
// skips writes whose fields are unchanged (`hasChangedFields`), which would
// otherwise make the normalized arm win by doing nothing at all.
describe("update one shared author held by 40 cached queries", () => {
  const HELD = 40;

  const store = createEntityStore();
  const { entities } = normalize(feedPayload(20, 5), entityDefs, "id");
  writeEntitiesToStore(entities, entityDefs, store);

  const naiveCache = Array.from({ length: HELD }, () => feedPayload(20, 5));

  let n = 0;

  bench("normalized — one store.set()", () => {
    store.set("User", "u7", { id: "u7", name: `Renamed ${n++}` });
  });

  bench("BASELINE naive cache — patch every embedded copy", () => {
    const name = `Renamed ${n++}`;
    for (const response of naiveCache) {
      for (const post of response.posts) {
        if (post.author.id === "u7") post.author = { ...post.author, name };
        for (const comment of post.comments) {
          if (comment.author.id === "u7") comment.author = { ...comment.author, name };
        }
      }
    }
  });
});
