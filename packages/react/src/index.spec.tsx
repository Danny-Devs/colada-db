/**
 * The contract of every hook in this package, as REAL tests.
 *
 * These were written against documented stubs BEFORE the hook bodies existed
 * (DAN-1047), so the contract was pinned first and the implementation had to
 * meet it: cleanup on unmount, referential stability of the snapshot, and
 * delivery of a second store's writes through sync. All three hooks are now
 * implemented and the suite is green.
 *
 * Rendering uses react-dom/client + React's own `act` (no testing-library —
 * fewer moving parts for a scaffold). `IS_REACT_ACT_ENVIRONMENT` is toggled
 * per test: on for synchronous render/unmount, OFF for the async sync tests
 * so external-store notifications can flush on React's own scheduler while
 * `vi.waitFor` polls the DOM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { createEntityStore, createStoreBoundary } from "colada-db";
import type { EntityStore, StoreBoundary } from "colada-db";
import { enableSync } from "@core/coordinator";
import type { SyncCoordinatorHandle } from "@core/coordinator";
import type { LocalChange, PullResult, PushResult, PushVerdict, RemoteChange, SyncAdapter } from "@core/sync-types";
import { useEntities, useEntity, useStoreVersion } from "./index";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const setActEnvironment = (on: boolean): void => {
  (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = on;
};

// ── Harness ──────────────────────────────────────────────────────────────────

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount(): void;
}

const mounted: Mounted[] = [];
const coordinators: SyncCoordinatorHandle[] = [];

function mount(element: ReactElement): Mounted {
  setActEnvironment(true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  const handle: Mounted = {
    container,
    root,
    unmount() {
      setActEnvironment(true);
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

afterEach(() => {
  for (const c of coordinators.splice(0)) c.stop();
  for (const m of mounted.splice(0)) {
    try {
      m.unmount();
    } catch {
      // A component that threw during render has no tree to unmount.
      m.container.remove();
    }
  }
  setActEnvironment(false);
});

/** The only origin the sync outbox accepts (coordinator-conformance.spec.ts:40 idiom). */
function localWrite(store: EntityStore, fn: () => void): void {
  store.runWith({ origin: "local-mutation" }, fn);
}

/**
 * A boundary whose three subscribe tiers report when their unsubscribe ran.
 * The hooks must call the returned unsubscribe on unmount — a leaked
 * listener keeps re-rendering a dead component's closure forever.
 */
function spiedBoundary(store: EntityStore) {
  const inner = createStoreBoundary(store);
  const unsubscribed = { global: 0, type: 0, entity: 0 };
  const boundary: StoreBoundary = {
    ...inner,
    subscribe(listener) {
      const off = inner.subscribe(listener);
      return () => {
        unsubscribed.global += 1;
        off();
      };
    },
    subscribeType(entityType, listener) {
      const off = inner.subscribeType(entityType, listener);
      return () => {
        unsubscribed.type += 1;
        off();
      };
    },
    subscribeEntity(entityType, id, listener) {
      const off = inner.subscribeEntity(entityType, id, listener);
      return () => {
        unsubscribed.entity += 1;
        off();
      };
    },
  };
  return { boundary, unsubscribed };
}

/**
 * The simplest honest server: one in-memory, server-authoritative hub shared by
 * every client, honouring ADR-006's shape — idempotent by mutationId,
 * tombstones not omissions, `confirmedMutations` on every pull (D1), and a
 * poke-first live channel so a push on one client pulls on the other without
 * waiting for the 30s poll. The demo's `hub.ts` is the fuller version and is
 * run through `runSyncAdapterContract`; this one stays inline so the react
 * package does not depend on the demo.
 */
function makeHub(): SyncAdapter {
  interface Row {
    entityType: string;
    id: string;
    data?: Record<string, unknown>;
    version: number;
    deleted: boolean;
  }
  const rows = new Map<string, Row>();
  const applied = new Map<string, PushVerdict>();
  const lastSeen = new Map<string, number>();
  const listeners = new Set<(e: { type: "poke" } | PullResult) => void>();
  let clock = 0;
  const poke = (): void => {
    queueMicrotask(() => {
      for (const l of listeners) l({ type: "poke" });
    });
  };
  return {
    async push(batch: LocalChange[]): Promise<PushResult> {
      const results: PushVerdict[] = [];
      for (const c of batch) {
        const seen = applied.get(c.mutationId);
        if (seen) {
          results.push(seen);
          continue;
        }
        clock += 1;
        rows.set(`${c.entityType}:${c.id}`, {
          entityType: c.entityType,
          id: c.id,
          data: c.data,
          version: clock,
          deleted: c.op === "remove",
        });
        lastSeen.set(c.clientId, Math.max(lastSeen.get(c.clientId) ?? 0, c.seq));
        const verdict: PushVerdict = { mutationId: c.mutationId, status: "ack", version: clock };
        applied.set(c.mutationId, verdict);
        results.push(verdict);
      }
      poke();
      return { results };
    },
    async pull(cursor): Promise<PullResult> {
      const from = cursor === null ? 0 : Number(cursor);
      const pending = [...rows.values()].filter((r) => r.version > from).sort((a, b) => a.version - b.version);
      const changes: RemoteChange[] = pending.map((r) => ({
        type: r.deleted ? "remove" : "set",
        entityType: r.entityType,
        id: r.id,
        ...(r.deleted ? {} : { data: r.data }),
        version: r.version,
      }));
      return {
        type: "changes",
        changes,
        cursor: String(pending.at(-1)?.version ?? from),
        complete: true,
        confirmedMutations: Object.fromEntries(lastSeen),
      };
    },
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => {
        listeners.delete(onEvent);
      };
    },
  };
}

/** Two independent stores, each its own client, both synced through ONE hub. */
function twoSyncedStores() {
  const hub = makeHub();
  const a = createEntityStore();
  const b = createEntityStore();
  coordinators.push(
    enableSync(a, { adapter: hub, clientId: `a-${Math.random().toString(36).slice(2)}` }),
    enableSync(b, { adapter: hub, clientId: `b-${Math.random().toString(36).slice(2)}` }),
  );
  return { a, b };
}

// ── useStoreVersion ─────────────────────────────────────────────────────────

describe("useStoreVersion", () => {
  function Version({ boundary }: { boundary: StoreBoundary }) {
    const version = useStoreVersion(boundary);
    return <span data-testid="v">{version}</span>;
  }

  it("(4) increments on a store write and re-renders the component", async () => {
    const store = createEntityStore();
    const boundary = createStoreBoundary(store);
    const { container } = mount(<Version boundary={boundary} />);
    const read = (): number => Number(container.querySelector("[data-testid=v]")!.textContent);
    const before = read();

    act(() => store.set("todo", "t1", { id: "t1", title: "first" }));
    expect(read()).toBe(before + 1);

    act(() => store.set("todo", "t1", { id: "t1", title: "second" }));
    expect(read()).toBe(before + 2);

    // A no-op write emits no event, so the version — and the render — hold.
    act(() => store.set("todo", "t1", { id: "t1", title: "second" }));
    expect(read()).toBe(before + 2);
  });

  it("(1) unsubscribes from the boundary's global tier on unmount", () => {
    const { boundary, unsubscribed } = spiedBoundary(createEntityStore());
    const handle = mount(<Version boundary={boundary} />);
    expect(unsubscribed.global).toBe(0);
    handle.unmount();
    expect(unsubscribed.global).toBe(1);
  });

  it("(3) ticks when a second store's write arrives through sync", async () => {
    const { a, b } = twoSyncedStores();
    const boundaryB = createStoreBoundary(b);
    const { container } = mount(<Version boundary={boundaryB} />);
    const read = (): number => Number(container.querySelector("[data-testid=v]")!.textContent);
    const before = read();

    setActEnvironment(false); // let the sync-pull notification flush on React's own scheduler
    localWrite(a, () => a.set("todo", "t1", { id: "t1", title: "from A" }));

    await vi.waitFor(() => expect(read()).toBeGreaterThan(before), { timeout: 2000 });
    expect(b.has("todo", "t1")).toBe(true);
  });
});

// ── useEntities ─────────────────────────────────────────────────────────────

describe("useEntities", () => {
  const snapshots: ReadonlyArray<unknown>[] = [];
  let renders = 0;

  function List({ boundary, tick }: { boundary: StoreBoundary; tick: number }) {
    renders += 1;
    const todos = useEntities(boundary, "todo");
    snapshots.push(todos);
    return (
      <ul data-tick={tick}>
        {todos.map((t) => (
          <li key={t.id}>{String(t.data.title)}</li>
        ))}
      </ul>
    );
  }

  /** A parent that can re-render `List` with no store change in between. */
  function Rerenderable({ boundary, expose }: { boundary: StoreBoundary; expose: (bump: () => void) => void }) {
    const [tick, setTick] = useState(0);
    expose(() => setTick((t) => t + 1));
    return <List boundary={boundary} tick={tick} />;
  }

  it("(1) unsubscribes from subscribeType on unmount", () => {
    const { boundary, unsubscribed } = spiedBoundary(createEntityStore());
    const handle = mount(<List boundary={boundary} tick={0} />);
    handle.unmount();
    expect(unsubscribed.type).toBe(1);
  });

  it("(2) returns a referentially stable snapshot across re-renders with no store change, and does not loop", () => {
    snapshots.length = 0;
    renders = 0;
    const store = createEntityStore();
    store.set("todo", "t1", { id: "t1", title: "one" });
    const boundary = createStoreBoundary(store);
    let bump: () => void = () => {};
    mount(<Rerenderable boundary={boundary} expose={(b) => (bump = b)} />);

    act(() => bump());
    act(() => bump());

    // Same reference every render while nothing changed — the
    // useSyncExternalStore law. `getEntities()` returns a fresh array each
    // call, so this only holds if the hook caches the snapshot.
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    for (const s of snapshots) expect(s).toBe(snapshots[0]);
    // No re-render storm: three deliberate renders, nothing more.
    expect(renders).toBeLessThanOrEqual(3);
  });

  it("(2b) a store change produces a new snapshot that reflects the write", () => {
    snapshots.length = 0;
    const store = createEntityStore();
    const boundary = createStoreBoundary(store);
    const { container } = mount(<List boundary={boundary} tick={0} />);
    const first = snapshots.at(-1);

    act(() => store.set("todo", "t1", { id: "t1", title: "one" }));
    expect(snapshots.at(-1)).not.toBe(first);
    expect(container.textContent).toBe("one");
  });

  it("(3) sees a write made on a SECOND store that arrives through sync", async () => {
    const { a, b } = twoSyncedStores();
    const { container } = mount(<List boundary={createStoreBoundary(b)} tick={0} />);

    setActEnvironment(false);
    localWrite(a, () => a.set("todo", "t1", { id: "t1", title: "from A" }));

    await vi.waitFor(() => expect(container.textContent).toBe("from A"), { timeout: 2000 });
  });
});

// ── useEntity ────────────────────────────────────────────────────────────────

describe("useEntity", () => {
  const snapshots: unknown[] = [];

  function One({ boundary, id, tick }: { boundary: StoreBoundary; id: string; tick: number }) {
    const entity = useEntity(boundary, "todo", id);
    snapshots.push(entity);
    return <span data-tick={tick}>{entity ? String(entity.title) : "∅"}</span>;
  }

  function Rerenderable({ boundary, expose }: { boundary: StoreBoundary; expose: (bump: () => void) => void }) {
    const [tick, setTick] = useState(0);
    expose(() => setTick((t) => t + 1));
    return <One boundary={boundary} id="t1" tick={tick} />;
  }

  it("(1) unsubscribes from subscribeEntity on unmount", () => {
    const { boundary, unsubscribed } = spiedBoundary(createEntityStore());
    const handle = mount(<One boundary={boundary} id="t1" tick={0} />);
    handle.unmount();
    expect(unsubscribed.entity).toBe(1);
  });

  it("(2) returns the same reference across re-renders when nothing changed", () => {
    snapshots.length = 0;
    const store = createEntityStore();
    store.set("todo", "t1", { id: "t1", title: "one" });
    const boundary = createStoreBoundary(store);
    let bump: () => void = () => {};
    mount(<Rerenderable boundary={boundary} expose={(b) => (bump = b)} />);
    act(() => bump());
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (const s of snapshots) expect(s).toBe(snapshots[0]);
  });

  it("(3) re-renders only for its own key, and sees a second store's write through sync", async () => {
    const { a, b } = twoSyncedStores();
    const { container } = mount(<One boundary={createStoreBoundary(b)} id="t1" tick={0} />);
    expect(container.textContent).toBe("∅");

    setActEnvironment(false);
    localWrite(a, () => a.set("todo", "t1", { id: "t1", title: "from A" }));
    await vi.waitFor(() => expect(container.textContent).toBe("from A"), { timeout: 2000 });
  });
});
