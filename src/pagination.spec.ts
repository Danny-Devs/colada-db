/**
 * Pagination merge recipes — the unit contract.
 *
 * ## Why this file arrived late, and what that says
 *
 * `cursorPagination`, `offsetPagination` and `relayPagination` have been
 * exported from `src/index.ts` since extraction and shipped in `colada-db@0.1.0`
 * — with **no test anywhere in this repository.** The only coverage that existed
 * lived in the Vue plugin's frozen fork of the engine, so the module was
 * published untested and looked tested, because someone else's copy had tests.
 *
 * That is the same shape as this repo's false-green family, moved one level out:
 * coverage that appears to exist because it exists *somewhere*. Chip 3 deletes
 * that fork, so these tests were about to go from misplaced to gone.
 *
 * Ported from `pinia-colada-normalizer/src/pagination.spec.ts` lines 28–651 —
 * the framework-free half. The `useQuery` / `useInfiniteQuery` integration half
 * stays in the plugin, where the framework it integrates with lives.
 */
import { describe, expect, it } from "vitest";
import { cursorPagination, offsetPagination, relayPagination } from "./pagination";
import type { RelayPageInfo } from "./pagination";
import type { EntityRecord } from "./types";

describe("cursorPagination", () => {
  interface Feed extends EntityRecord {
    feedId: string;
    items: Array<{ id: string; text: string }>;
    endCursor: string | null;
  }

  it("appends incoming items in forward direction", () => {
    const merge = cursorPagination<Feed>({
      getCursor: (f) => f.endCursor,
      itemsField: "items",
    });

    const existing: Feed = {
      feedId: "main",
      items: [{ id: "1", text: "first" }],
      endCursor: "cursor-1",
    };

    const incoming: Feed = {
      feedId: "main",
      items: [{ id: "2", text: "second" }],
      endCursor: "cursor-2",
    };

    const result = merge(existing, incoming);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe("1");
    expect(result.items[1].id).toBe("2");
    expect(result.endCursor).toBe("cursor-2");
  });

  it("prepends incoming items in backward direction", () => {
    const merge = cursorPagination<Feed>({
      getCursor: (f) => f.endCursor,
      itemsField: "items",
      direction: "backward",
    });

    const existing: Feed = {
      feedId: "main",
      items: [{ id: "2", text: "second" }],
      endCursor: "cursor-2",
    };

    const incoming: Feed = {
      feedId: "main",
      items: [{ id: "1", text: "first" }],
      endCursor: "cursor-1",
    };

    const result = merge(existing, incoming);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe("1");
    expect(result.items[1].id).toBe("2");
  });

  it("replaces when cursors match (same page refresh)", () => {
    const merge = cursorPagination<Feed>({
      getCursor: (f) => f.endCursor,
      itemsField: "items",
    });

    const existing: Feed = {
      feedId: "main",
      items: [{ id: "1", text: "old" }],
      endCursor: "cursor-1",
    };

    const incoming: Feed = {
      feedId: "main",
      items: [{ id: "1", text: "new" }],
      endCursor: "cursor-1",
    };

    const result = merge(existing, incoming);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].text).toBe("new");
  });

  it("deduplicates items by key field", () => {
    const merge = cursorPagination<Feed>({
      getCursor: (f) => f.endCursor,
      itemsField: "items",
      dedupeKey: "id",
    });

    const existing: Feed = {
      feedId: "main",
      items: [
        { id: "1", text: "first" },
        { id: "2", text: "second" },
      ],
      endCursor: "cursor-1",
    };

    const incoming: Feed = {
      feedId: "main",
      items: [
        { id: "2", text: "second-updated" },
        { id: "3", text: "third" },
      ],
      endCursor: "cursor-2",
    };

    const result = merge(existing, incoming);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].id).toBe("1");
    // The newer version of id:2 should win
    expect(result.items.find((i: any) => i.id === "2")!.text).toBe("second-updated");
    expect(result.items[result.items.length - 1].id).toBe("3");
  });

  it("defaults to 'items' field", () => {
    const merge = cursorPagination({
      getCursor: (f) => f.cursor as string,
    });

    const existing = { id: "1", items: [1, 2], cursor: "a" };
    const incoming = { id: "1", items: [3, 4], cursor: "b" };

    const result = merge(existing, incoming);
    expect(result.items).toEqual([1, 2, 3, 4]);
  });

  it("handles empty incoming items", () => {
    const merge = cursorPagination<Feed>({
      getCursor: (f) => f.endCursor,
      itemsField: "items",
    });

    const existing: Feed = {
      feedId: "main",
      items: [{ id: "1", text: "first" }],
      endCursor: "cursor-1",
    };

    const incoming: Feed = {
      feedId: "main",
      items: [],
      endCursor: "cursor-2",
    };

    const result = merge(existing, incoming);
    expect(result.items).toHaveLength(1);
    expect(result.endCursor).toBe("cursor-2");
  });

  it("handles missing items field gracefully", () => {
    const merge = cursorPagination({
      getCursor: (f) => f.cursor as string,
      itemsField: "items",
    });

    const existing = { id: "1", cursor: "a" };
    const incoming = { id: "1", items: [1, 2], cursor: "b" };

    const result = merge(existing, incoming);
    expect(result.items).toEqual([1, 2]);
  });
});

describe("offsetPagination", () => {
  interface PagedList extends EntityRecord {
    listId: string;
    items: Array<{ id: string; name: string }>;
    offset: number;
    total: number;
  }

  it("merges items at correct offset positions", () => {
    const merge = offsetPagination<PagedList>({
      getOffset: (l) => l.offset,
      pageSize: 2,
      itemsField: "items",
    });

    const existing: PagedList = {
      listId: "contacts",
      items: [
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
      ],
      offset: 0,
      total: 4,
    };

    const incoming: PagedList = {
      listId: "contacts",
      items: [
        { id: "3", name: "Charlie" },
        { id: "4", name: "Diana" },
      ],
      offset: 2,
      total: 4,
    };

    const result = merge(existing, incoming);
    expect(result.items).toHaveLength(4);
    expect(result.items[0].name).toBe("Alice");
    expect(result.items[1].name).toBe("Bob");
    expect(result.items[2].name).toBe("Charlie");
    expect(result.items[3].name).toBe("Diana");
    expect(result.total).toBe(4);
  });

  it("replaces when same offset (page refresh)", () => {
    const merge = offsetPagination<PagedList>({
      getOffset: (l) => l.offset,
      pageSize: 2,
      itemsField: "items",
    });

    const existing: PagedList = {
      listId: "contacts",
      items: [{ id: "1", name: "Old Alice" }],
      offset: 0,
      total: 1,
    };

    const incoming: PagedList = {
      listId: "contacts",
      items: [{ id: "1", name: "New Alice" }],
      offset: 0,
      total: 1,
    };

    const result = merge(existing, incoming);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("New Alice");
  });

  it("deduplicates items by key field", () => {
    const merge = offsetPagination<PagedList>({
      getOffset: (l) => l.offset,
      pageSize: 2,
      itemsField: "items",
      dedupeKey: "id",
    });

    const existing: PagedList = {
      listId: "contacts",
      items: [
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
      ],
      offset: 0,
      total: 3,
    };

    // Overlapping page — item id:2 exists in both
    const incoming: PagedList = {
      listId: "contacts",
      items: [
        { id: "2", name: "Bob Updated" },
        { id: "3", name: "Charlie" },
      ],
      offset: 1,
      total: 3,
    };

    const result = merge(existing, incoming);
    // Should have 3 unique items
    expect(result.items.filter((i: any) => i.id === "2")).toHaveLength(1);
    expect(result.items.find((i: any) => i.id === "2")!.name).toBe("Bob Updated");

    // ⚠️ The two assertions above pass WITH THE DEDUP PASS REMOVED, and this
    // comment is here so nobody mistakes them for coverage of it. At these
    // offsets the positional overlay already collapses the duplicate: incoming
    // offset 1 writes "2" into index 1, which is where the existing "2" sat.
    // The test proves the overlay, not the dedup.
    //
    // Below is the case that genuinely requires dedup — the same id arriving at
    // a DIFFERENT index, which the overlay cannot collapse because it writes
    // somewhere else. Verified by mutation: removing `mergedItems.splice(i, 1)`
    // from pagination.ts turns this red and leaves the two above green.
    const shifted = merge(
      {
        listId: "contacts",
        items: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
          { id: "c", name: "C" },
        ],
        offset: 0,
        total: 5,
      },
      {
        listId: "contacts",
        items: [
          { id: "c", name: "C again" },
          { id: "d", name: "D" },
        ],
        offset: 3,
        total: 5,
      },
    );
    expect(
      shifted.items.filter((i: any) => i.id === "c"),
      "id 'c' survived at two indices — the dedup pass is not running",
    ).toHaveLength(1);
  });

  it("derives placement from getOffset alone — pageSize is inert", () => {
    // Pins the behaviour the type now admits to. Through 0.1.0 `pageSize` was
    // REQUIRED and documented as controlling placement, while the
    // implementation destructured it as `_pageSize` and never read it: a
    // mandatory option that did nothing, promising behaviour that did not
    // exist. Caught in review before it was frozen into the public surface.
    //
    // Two merges identical but for `pageSize` must produce identical output.
    // If someone later implements the documented behaviour this test fails —
    // which is correct, because that would be a behaviour change to a
    // published function and must never happen silently.
    const base = { getOffset: (l: any) => l.offset as number, itemsField: "items" };
    const existing = { id: "1", items: [{ id: "a" }, { id: "b" }], offset: 0 };
    const incoming = { id: "1", items: [{ id: "c" }], offset: 2 };

    const withPageSize = offsetPagination({ ...base, pageSize: 2 })(existing, incoming);
    const withAbsurd = offsetPagination({ ...base, pageSize: 9999 })(existing, incoming);
    const withNone = offsetPagination(base)(existing, incoming);

    expect(withPageSize).toEqual(withNone);
    expect(withAbsurd).toEqual(withNone);
    // And the placement that DOES apply is the offset's.
    expect((withNone.items as any[]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("defaults to 'items' field", () => {
    const merge = offsetPagination({
      getOffset: (l) => l.offset as number,
    });

    const existing = { id: "1", items: [1, 2], offset: 0 };
    const incoming = { id: "1", items: [3, 4], offset: 2 };

    const result = merge(existing, incoming);
    expect(result.items).toEqual([1, 2, 3, 4]);
  });
});

describe("relayPagination", () => {
  interface UserNode extends EntityRecord {
    id: string;
    name: string;
  }

  interface UsersConnection extends EntityRecord {
    connectionId: string;
    edges: Array<{ node: UserNode; cursor: string }>;
    pageInfo: RelayPageInfo;
  }

  const makeConnection = (
    id: string,
    edges: Array<{ node: UserNode; cursor: string }>,
    pageInfo: Partial<RelayPageInfo> = {},
  ): UsersConnection => ({
    connectionId: id,
    edges,
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
      ...pageInfo,
    },
  });

  it("appends edges in forward direction", () => {
    const merge = relayPagination<UsersConnection>();

    const existing = makeConnection(
      "users",
      [
        { node: { id: "1", name: "Alice" }, cursor: "c1" },
        { node: { id: "2", name: "Bob" }, cursor: "c2" },
      ],
      { hasNextPage: true, hasPreviousPage: false },
    );

    const incoming = makeConnection(
      "users",
      [
        { node: { id: "3", name: "Charlie" }, cursor: "c3" },
        { node: { id: "4", name: "Diana" }, cursor: "c4" },
      ],
      { hasNextPage: false, hasPreviousPage: true },
    );

    const result = merge(existing, incoming);
    expect(result.edges).toHaveLength(4);
    expect(result.edges[0].node.name).toBe("Alice");
    expect(result.edges[1].node.name).toBe("Bob");
    expect(result.edges[2].node.name).toBe("Charlie");
    expect(result.edges[3].node.name).toBe("Diana");
  });

  it("prepends edges in backward direction", () => {
    const merge = relayPagination<UsersConnection>({ direction: "backward" });

    const existing = makeConnection(
      "users",
      [
        { node: { id: "3", name: "Charlie" }, cursor: "c3" },
        { node: { id: "4", name: "Diana" }, cursor: "c4" },
      ],
      { hasNextPage: false, hasPreviousPage: true },
    );

    const incoming = makeConnection(
      "users",
      [
        { node: { id: "1", name: "Alice" }, cursor: "c1" },
        { node: { id: "2", name: "Bob" }, cursor: "c2" },
      ],
      { hasNextPage: true, hasPreviousPage: false },
    );

    const result = merge(existing, incoming);
    expect(result.edges).toHaveLength(4);
    expect(result.edges[0].node.name).toBe("Alice");
    expect(result.edges[1].node.name).toBe("Bob");
    expect(result.edges[2].node.name).toBe("Charlie");
    expect(result.edges[3].node.name).toBe("Diana");
  });

  it("stitches pageInfo correctly in forward direction", () => {
    const merge = relayPagination<UsersConnection>();

    const existing = makeConnection(
      "users",
      [{ node: { id: "1", name: "Alice" }, cursor: "c1" }],
      { hasNextPage: true, hasPreviousPage: false, startCursor: "c1", endCursor: "c1" },
    );

    const incoming = makeConnection(
      "users",
      [{ node: { id: "2", name: "Bob" }, cursor: "c2" }],
      { hasNextPage: false, hasPreviousPage: true, startCursor: "c2", endCursor: "c2" },
    );

    const result = merge(existing, incoming);
    // Forward: keep existing start, take incoming end
    expect(result.pageInfo.startCursor).toBe("c1");
    expect(result.pageInfo.endCursor).toBe("c2");
    // Forward: keep existing hasPreviousPage, take incoming hasNextPage
    expect(result.pageInfo.hasPreviousPage).toBe(false);
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it("stitches pageInfo correctly in backward direction", () => {
    const merge = relayPagination<UsersConnection>({ direction: "backward" });

    const existing = makeConnection(
      "users",
      [{ node: { id: "2", name: "Bob" }, cursor: "c2" }],
      { hasNextPage: false, hasPreviousPage: true, startCursor: "c2", endCursor: "c2" },
    );

    const incoming = makeConnection(
      "users",
      [{ node: { id: "1", name: "Alice" }, cursor: "c1" }],
      { hasNextPage: true, hasPreviousPage: false, startCursor: "c1", endCursor: "c1" },
    );

    const result = merge(existing, incoming);
    // Backward: take incoming start, keep existing end
    expect(result.pageInfo.startCursor).toBe("c1");
    expect(result.pageInfo.endCursor).toBe("c2");
    // Backward: take incoming hasPreviousPage, keep existing hasNextPage
    expect(result.pageInfo.hasPreviousPage).toBe(false);
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it("deduplicates edges by cursor (newer wins)", () => {
    const merge = relayPagination<UsersConnection>();

    const existing = makeConnection(
      "users",
      [
        { node: { id: "1", name: "Alice" }, cursor: "c1" },
        { node: { id: "2", name: "Bob" }, cursor: "c2" },
      ],
      { hasNextPage: true },
    );

    // Overlapping page — cursor "c2" appears in both
    const incoming = makeConnection(
      "users",
      [
        { node: { id: "2", name: "Bob Updated" }, cursor: "c2" },
        { node: { id: "3", name: "Charlie" }, cursor: "c3" },
      ],
      { hasNextPage: false },
    );

    const result = merge(existing, incoming);
    expect(result.edges).toHaveLength(3);
    // The newer version of cursor "c2" should win
    const c2Edge = result.edges.find((e: any) => e.cursor === "c2")!;
    expect(c2Edge.node.name).toBe("Bob Updated");
  });

  it("skips dedup when dedupeByCursor is false", () => {
    const merge = relayPagination<UsersConnection>({ dedupeByCursor: false });

    const existing = makeConnection(
      "users",
      [{ node: { id: "1", name: "Alice" }, cursor: "c1" }],
      { hasNextPage: true },
    );

    const incoming = makeConnection(
      "users",
      [{ node: { id: "1", name: "Alice Refreshed" }, cursor: "c1" }],
      { hasNextPage: false },
    );

    const result = merge(existing, incoming);
    // Both edges kept (duplicate cursors)
    expect(result.edges).toHaveLength(2);
  });

  it("returns incoming as-is when existing has no edges (first page)", () => {
    const merge = relayPagination<UsersConnection>();

    const existing = makeConnection("users", [], { hasNextPage: false });
    const incoming = makeConnection(
      "users",
      [{ node: { id: "1", name: "Alice" }, cursor: "c1" }],
      { hasNextPage: true },
    );

    const result = merge(existing, incoming);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].node.name).toBe("Alice");
    expect(result.pageInfo.hasNextPage).toBe(true);
  });

  it("preserves existing edges when incoming is empty (end of list)", () => {
    const merge = relayPagination<UsersConnection>();

    const existing = makeConnection(
      "users",
      [{ node: { id: "1", name: "Alice" }, cursor: "c1" }],
      { hasNextPage: true },
    );

    const incoming = makeConnection("users", [], {
      hasNextPage: false,
    });

    const result = merge(existing, incoming);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].node.name).toBe("Alice");
    // pageInfo updated from incoming (no more pages)
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it("works with custom field names", () => {
    const merge = relayPagination({
      edgesField: "results",
      pageInfoField: "paging",
    });

    const existing = {
      id: "search",
      results: [{ node: { id: "1" }, cursor: "a" }],
      paging: { hasNextPage: true, hasPreviousPage: false, startCursor: "a", endCursor: "a" },
    };

    const incoming = {
      id: "search",
      results: [{ node: { id: "2" }, cursor: "b" }],
      paging: { hasNextPage: false, hasPreviousPage: true, startCursor: "b", endCursor: "b" },
    };

    const result = merge(existing, incoming);
    expect((result.results as any[]).length).toBe(2);
    expect((result.paging as RelayPageInfo).endCursor).toBe("b");
    expect((result.paging as RelayPageInfo).startCursor).toBe("a");
  });

  it("handles edges without cursor field gracefully (no dedup)", () => {
    const merge = relayPagination();

    const existing = {
      id: "feed",
      edges: [{ node: { id: "1" } }],
      pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: null, endCursor: null },
    };

    const incoming = {
      id: "feed",
      edges: [{ node: { id: "2" } }],
      pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: null, endCursor: null },
    };

    const result = merge(existing, incoming);
    // No cursor → no dedup → both edges kept
    expect((result.edges as any[]).length).toBe(2);
    // Null cursors propagate correctly through pageInfo stitching
    expect((result.pageInfo as RelayPageInfo).startCursor).toBeNull();
    expect((result.pageInfo as RelayPageInfo).endCursor).toBeNull();
  });

  it("deduplicates correctly on full page refresh (identical edges)", () => {
    const merge = relayPagination<UsersConnection>();

    const existing = makeConnection(
      "users",
      [
        { node: { id: "1", name: "Alice" }, cursor: "c1" },
        { node: { id: "2", name: "Bob" }, cursor: "c2" },
      ],
      { hasNextPage: true, hasPreviousPage: false },
    );

    // Same page refetched (stale-while-revalidate)
    const incoming = makeConnection(
      "users",
      [
        { node: { id: "1", name: "Alice Fresh" }, cursor: "c1" },
        { node: { id: "2", name: "Bob Fresh" }, cursor: "c2" },
      ],
      { hasNextPage: true, hasPreviousPage: false },
    );

    const result = merge(existing, incoming);
    // Dedup keeps newer versions, count stays the same
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].node.name).toBe("Alice Fresh");
    expect(result.edges[1].node.name).toBe("Bob Fresh");
  });

  it("deduplicates within a single page when cursors repeat", () => {
    const merge = relayPagination<UsersConnection>();

    const existing = makeConnection(
      "users",
      [{ node: { id: "1", name: "Alice" }, cursor: "c1" }],
      { hasNextPage: true },
    );

    // Malformed server response: duplicate cursor within one page
    const incoming = makeConnection(
      "users",
      [
        { node: { id: "2", name: "Bob" }, cursor: "c2" },
        { node: { id: "3", name: "Charlie" }, cursor: "c2" },
      ],
      { hasNextPage: false },
    );

    const result = merge(existing, incoming);
    // c1 + one of the c2 duplicates (last wins)
    expect(result.edges).toHaveLength(2);
    const c2Edge = result.edges.find((e: any) => e.cursor === "c2")!;
    expect(c2Edge.node.name).toBe("Charlie");
  });

  it("handles null cursors in edges (skipped by dedup, not dropped)", () => {
    const merge = relayPagination();

    const existing = {
      id: "feed",
      edges: [{ node: { id: "1" }, cursor: null }],
      pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: null, endCursor: null },
    };

    const incoming = {
      id: "feed",
      edges: [{ node: { id: "2" }, cursor: null }],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    };

    const result = merge(existing, incoming);
    // null cursors are not strings, so dedup skips them — both kept
    expect((result.edges as any[]).length).toBe(2);
  });
});

// ─────────────────────────────────────────────
