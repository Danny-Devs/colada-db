import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useStoreVersion } from "@colada-db/react";
import { createSyncHub } from "./hub";
import type { SyncHub } from "./hub";
import { createPaneClient, ENGINE_OPTIONS, TODO_TYPE } from "./client";
import type { EngineChoice, PaneClient, PaneName, TodoData } from "./client";

/** Re-render on an interval — for the non-reactive diagnostics (`getPendingCount`, `getRetryState`, `persistent`). */
function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function App() {
  const [hub] = useState<SyncHub>(() => createSyncHub());
  return (
    <main className="app">
      <header>
        <h1>
          colada-db <span className="accent">sync demo</span> — two clients, one in-page hub
        </h1>
        <p className="banner" role="note">
          <strong>What this is NOT:</strong> no backend, no network, no HTTP. Both panes sync through an
          in-memory, server-authoritative hub living in this page (<code>hub.ts</code> implements{" "}
          <code>SyncAdapter</code> directly and passes the ADR-006 conformance kit). ADR-023's server
          conformance kit and reference server are still open. Neither pane wires the durable outbox
          (<code>outboxEngine</code>), so writes queued while offline live in memory and do not survive an
          engine switch or a reload.
        </p>
      </header>
      <HubStatus hub={hub} />
      <section className="panes">
        <Pane name="left" hub={hub} />
        <Pane name="right" hub={hub} />
      </section>
    </main>
  );
}

function HubStatus({ hub }: { hub: SyncHub }) {
  const [, setN] = useState(0);
  useEffect(() => hub.onChange(() => setN((n) => n + 1)), [hub]);
  const s = hub.stats();
  return (
    <div className="hub">
      <span className="label">hub (server-authoritative, in-memory)</span>
      <span>live rows: {s.live}</span>
      <span>tombstones: {s.tombstones}</span>
      <span>clock: {s.clock}</span>
      <span>clients seen: {s.clients}</span>
    </div>
  );
}

function Pane({ name, hub }: { name: PaneName; hub: SyncHub }) {
  const [engine, setEngine] = useState<EngineChoice>("memory");
  const [online, setOnlineState] = useState(true);
  const onlineRef = useRef(online);
  const [client, setClient] = useState<PaneClient | null>(null);

  // A new client per engine choice. The network toggle survives the rebuild
  // (its flag is carried over); the in-memory outbox does not — see banner.
  useEffect(() => {
    let cancelled = false;
    const next = createPaneClient({ pane: name, engine, hub: hub.adapter, online: onlineRef.current });
    void next.ready.then(() => {
      if (!cancelled) setClient(next);
    });
    return () => {
      cancelled = true;
      setClient(null);
      next.dispose();
    };
  }, [engine, hub, name]);

  const setOnline = (next: boolean): void => {
    onlineRef.current = next;
    client?.network.setOnline(next);
    setOnlineState(next);
  };

  return (
    <article className="pane" aria-label={`client ${name}`}>
      <h2>
        client <span className="accent">{name}</span>
      </h2>
      <div className="controls">
        <label>
          engine{" "}
          <select value={engine} onChange={(e) => setEngine(e.target.value as EngineChoice)}>
            {ENGINE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className={online ? "net on" : "net off"}>
          <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> network:{" "}
          <strong>{online ? "on" : "off"}</strong>
        </label>
      </div>
      {client ? <PaneView client={client} /> : <p className="muted">opening {engine}…</p>}
    </article>
  );
}

function PaneView({ client }: { client: PaneClient }) {
  // TEMP: reads through useStoreVersion until Danny lands useEntities (DAN-1047)
  const version = useStoreVersion(client.boundary);
  const todos = client.boundary
    .getEntities(TODO_TYPE)
    .map((e) => ({ id: e.id, data: e.data as Partial<TodoData> }))
    .sort((a, b) => (a.data.createdAt ?? 0) - (b.data.createdAt ?? 0));

  useTick(250);
  const pending = client.sync.getPendingCount();
  const retry = client.sync.getRetryState();
  const parked = client.network.parkedCount();
  const persistent = client.persistent();

  const [draft, setDraft] = useState("");
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    client.addTodo(title);
    setDraft("");
  };

  return (
    <>
      <dl className="status">
        <dt>store version</dt>
        <dd>{version}</dd>
        <dt>outbox pending</dt>
        <dd className={pending > 0 ? "warn" : ""}>{pending}</dd>
        <dt>requests parked</dt>
        <dd className={parked > 0 ? "warn" : ""}>{parked}</dd>
        <dt>push retry</dt>
        <dd>
          {retry.suspendedForSchema
            ? "suspended (schema)"
            : retry.suspendedForOutboxFault
              ? "suspended (outbox fault)"
              : retry.attempt === 0
                ? "—"
                : `attempt ${retry.attempt}`}
        </dd>
        {client.engineChoice === "sqlite-opfs" && (
          <>
            <dt>OPFS persistent</dt>
            <dd className={persistent === false ? "warn" : ""}>{persistent === null ? "opening…" : String(persistent)}</dd>
          </>
        )}
        <dt>clientId</dt>
        <dd className="mono">{client.clientId}</dd>
      </dl>

      <form onSubmit={submit} className="add">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="new todo title"
          aria-label="new todo title"
        />
        <button type="submit">add</button>
      </form>

      {todos.length === 0 ? (
        <p className="muted">no todos yet</p>
      ) : (
        <ul className="todos">
          {todos.map((t) => (
            <TodoRow
              key={t.id}
              id={t.id}
              title={String(t.data.title ?? "")}
              onRename={(title) => client.renameTodo(t.id, title)}
              onRemove={() => client.removeTodo(t.id)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function TodoRow({
  id,
  title,
  onRename,
  onRemove,
}: {
  id: string;
  title: string;
  onRename: (title: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(title);
  const [editing, setEditing] = useState(false);
  // Follow remote renames while not editing.
  if (!editing && draft !== title) setDraft(title);

  const commit = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename(next);
    else setDraft(title);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    if (e.key === "Escape") {
      setDraft(title);
      setEditing(false);
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <li>
      <input
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        aria-label={`title of ${id}`}
      />
      <span className="mono id" title={id}>
        {id}
      </span>
      <button type="button" onClick={onRemove} aria-label={`delete ${id}`}>
        delete
      </button>
    </li>
  );
}
