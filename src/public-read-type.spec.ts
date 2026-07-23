/**
 * The pin for ADR-019: colada-db owns its public read type.
 *
 * Two independent guards, because they fail in different places:
 *
 * 1. **Compile-time** — the assertions below are checked by `pnpm typecheck`
 *    (`tsc --noEmit`, which includes every file under `src`). The public read
 *    API must be satisfiable by a PLAIN object. A framework ref type carries a
 *    unique-symbol brand (`Ref` declares `[RefSymbol]: true`), so retyping
 *    `get()` back to `ShallowRef` makes `plainBox` un-assignable and this file
 *    stops compiling.
 * 2. **Build-time** — `scripts/check-public-types.mjs`, wired into `pnpm build`,
 *    greps the emitted `dist/index.d.mts` for the framework package. That is the
 *    artifact a consumer's IDE actually reads, and the only place a leak through
 *    some *other* barrel-exported type would surface.
 *
 * The runtime tests assert the other half of ADR-019 — that widening the
 * DECLARED type did not change the RETURNED value: what comes back is still the
 * engine's own live ref, which is exactly what the Vue adapter's fast path
 * shares (ADR-008 §3).
 */
import { computed, isRef, shallowRef } from "@vue/reactivity";
import { describe, expect, it } from "vitest";
import { createEntityStore } from "./store";
import type { ColadaRef, EntityRecord, EntityStore } from "./types";

// ─────────────────────────────────────────────
// 1. Compile-time pin (checked by `tsc --noEmit`)
// ─────────────────────────────────────────────

type GetReturn = ReturnType<EntityStore["get"]>;
type GetByTypeReturn = ReturnType<EntityStore["getByType"]>;

/**
 * The load-bearing assertion: a plain, framework-free object literal is a valid
 * value of the public read API's return type. That can only hold while the type
 * is structural and unbranded — i.e. while it is OURS.
 */
const plainBox: { readonly value: EntityRecord | undefined } = { value: undefined };
const publicGet: GetReturn = plainBox;
const publicGetByType: GetByTypeReturn = { value: [] as EntityRecord[] };

/** And the engine's real refs still satisfy it (the widening direction). */
const engineRefIsColadaRef: ColadaRef<EntityRecord | undefined> = shallowRef<
  EntityRecord | undefined
>(undefined);
const engineComputedIsColadaRef: ColadaRef<EntityRecord[]> = computed(() => [] as EntityRecord[]);

/** `.value` is read-only on the public contract — writes go through the store. */
// @ts-expect-error — ColadaRef.value is readonly; use set()/replace()/update().
publicGet.value = { id: "nope" };

// Keep the fixtures referenced so they can never be pruned as dead code.
void publicGetByType;
void engineRefIsColadaRef;
void engineComputedIsColadaRef;

// ─────────────────────────────────────────────
// 2. Runtime: the declaration widened, the value did not
// ─────────────────────────────────────────────

describe("ADR-019 — the owned read type is a widening, not a change of value", () => {
  it("get() still hands out the engine's live ref (the Vue fast path's object)", () => {
    const store = createEntityStore();
    const ref = store.get("contact", "1");

    // Still a real engine ref — this is the object the Vue adapter shares
    // directly instead of re-wrapping through the subscription boundary.
    expect(isRef(ref)).toBe(true);

    // Identity: repeated get() returns the SAME box, so a shared ref stays
    // shared. Retyping must not introduce a wrapper.
    expect(store.get("contact", "1")).toBe(ref);
  });

  it("the returned ref still tracks and triggers", () => {
    const store = createEntityStore();
    const ref = store.get("contact", "1");
    const view = computed(() => ref.value?.name);

    expect(view.value).toBeUndefined();
    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(view.value).toBe("Alice");
    store.set("contact", "1", { id: "1", name: "Grace" });
    expect(view.value).toBe("Grace");
  });

  it("getByType() still returns a live, memoized derived ref", () => {
    const store = createEntityStore();
    const all = store.getByType("contact");

    expect(isRef(all)).toBe(true);
    expect(all.value).toEqual([]);

    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(all.value).toEqual([{ id: "1", name: "Alice" }]);

    // Memoized — one derived box per entity type.
    expect(store.getByType("contact")).toBe(all);
  });

  it("a hand-rolled ColadaRef needs no framework machinery", () => {
    // The consumer-facing consequence of owning the type: a non-Vue consumer
    // can satisfy the read contract with an ordinary object.
    let backing: EntityRecord | undefined = { id: "1" };
    const handRolled: ColadaRef<EntityRecord | undefined> = {
      get value() {
        return backing;
      },
    };

    expect(handRolled.value).toEqual({ id: "1" });
    backing = undefined;
    expect(handRolled.value).toBeUndefined();
    expect(isRef(handRolled)).toBe(false);
  });
});
