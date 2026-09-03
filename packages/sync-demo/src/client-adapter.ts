/**
 * The per-pane network gate — what the `network: on/off` toggle actually does.
 *
 * Each pane wraps the ONE hub adapter in its own `SyncAdapter` whose calls
 * pass straight through while online and PARK while offline: an offline
 * `push()` / `pull()` returns a promise that does not settle until the toggle
 * flips back on, then runs against the hub as if the request had just been
 * made. Pokes from the hub are held too and re-delivered once on reconnect.
 *
 * Why park rather than fail: the coordinator (`src/coordinator.ts`) retries a
 * THROWN push with D9's exponential backoff — full jitter, 1s → 60s cap — and
 * exposes no "retry now" affordance, so a fail-fast offline mode would drain
 * on reconnect at some random moment up to a minute later. Parking makes
 * reconnect drain immediately, which is what a demo needs to show. The cost is
 * honesty about what is NOT shown: this toggle models a partition where
 * in-flight requests never return until it heals, not a fast-failing network,
 * so D9's backoff path is not exercised here. (Whether the coordinator should
 * grow a `flushNow()` is a real question — noted in the README.)
 *
 * The outbox itself is untouched by all this. While offline the coordinator's
 * first push parks with `pushInFlight = true`, so every later local write
 * simply accumulates in the outbox (`getPendingCount()` is the number the UI
 * shows); on reconnect the parked push resolves and the coordinator drains
 * the rest on its own.
 */
import type { PullResult, SyncAdapter } from "@core/sync-types";

export interface NetworkControl {
  isOnline(): boolean;
  setOnline(online: boolean): void;
  /** Requests currently parked behind the gate (pushes + pulls). */
  parkedCount(): number;
  onChange(listener: () => void): () => void;
  /** Reject every parked request and detach from the hub. The client that owned this gate is gone. */
  dispose(): void;
}

export interface ClientAdapter {
  adapter: SyncAdapter;
  network: NetworkControl;
}

type LiveEvent = { type: "poke" } | PullResult;

export function createClientAdapter(hub: SyncAdapter, opts: { online: boolean }): ClientAdapter {
  let online = opts.online;
  let disposed = false;
  const parked: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  const listeners = new Set<() => void>();
  const liveHandlers = new Set<(e: LiveEvent) => void>();
  const hubDisposers: Array<() => void> = [];
  let missedPoke = false;

  const notify = (): void => {
    for (const l of listeners) l();
  };

  /** Resolves now when online, or when the toggle next flips on. */
  function gate(): Promise<void> {
    if (disposed) return Promise.reject(new Error("transient: client disposed"));
    if (online) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      parked.push({ resolve, reject });
      notify();
    });
  }

  const adapter: SyncAdapter = {
    async push(batch, pushOpts) {
      await gate();
      return hub.push(batch, pushOpts);
    },
    async pull(cursor, pullOpts) {
      await gate();
      return hub.pull(cursor, pullOpts);
    },
    subscribe(onEvent) {
      liveHandlers.add(onEvent);
      const off = hub.subscribe
        ? hub.subscribe((e) => {
            if (disposed) return;
            if (online) onEvent(e);
            else missedPoke = true; // held, re-delivered once on reconnect
          })
        : () => {};
      hubDisposers.push(off);
      return () => {
        liveHandlers.delete(onEvent);
        off();
      };
    },
    // Deliberately no compareVersions — the hub has none either.
  };

  const network: NetworkControl = {
    isOnline: () => online,
    setOnline(next) {
      if (disposed || next === online) return;
      online = next;
      if (next) {
        for (const p of parked.splice(0)) p.resolve();
        if (missedPoke) {
          missedPoke = false;
          for (const h of liveHandlers) h({ type: "poke" });
        }
      }
      notify();
    },
    parkedCount: () => parked.length,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const p of parked.splice(0)) p.reject(new Error("transient: client disposed"));
      for (const off of hubDisposers.splice(0)) off();
      liveHandlers.clear();
      notify();
      listeners.clear();
    },
  };

  return { adapter, network };
}
