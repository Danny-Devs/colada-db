/**
 * Pagination merge recipe factories for `defineEntity({ merge })`.
 * @module pinia-colada-plugin-normalizer/pagination
 */

import type { EntityRecord } from "./types";

// ─────────────────────────────────────────────
// Relay Connection Types (GraphQL Connection Spec)
// ─────────────────────────────────────────────

/** @see https://relay.dev/graphql/connections.htm */
export interface RelayPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface RelayEdge<TNode = EntityRecord> {
  node: TNode;
  cursor: string | null;
}

export interface RelayConnection<TNode = EntityRecord> extends EntityRecord {
  edges: RelayEdge<TNode>[];
  pageInfo: RelayPageInfo;
}

// ─────────────────────────────────────────────
// Cursor-based Pagination
// ─────────────────────────────────────────────

/**
 * Options for cursor-based pagination merge.
 */
export interface CursorPaginationOptions<T extends EntityRecord = EntityRecord> {
  /**
   * Extract the cursor value from the entity.
   * This determines where the entity's "page boundary" is.
   *
   * @example
   * getCursor: (feed) => feed.endCursor
   */
  getCursor: (entity: T) => string | number | null | undefined;

  /**
   * The field on the entity that contains the items array.
   * @default 'items'
   */
  itemsField?: string;

  /**
   * Merge direction.
   * - 'forward': append new items after existing ones (default)
   * - 'backward': prepend new items before existing ones
   * @default 'forward'
   */
  direction?: "forward" | "backward";

  /**
   * Whether to deduplicate items by a key field.
   * When set, items with the same key value are kept only once
   * (the newer version wins).
   * @default undefined (no dedup)
   */
  dedupeKey?: string;
}

/**
 * Creates a merge function for cursor-based pagination.
 *
 * Returns a merge function suitable for `defineEntity({ merge })`.
 * When the entity store merges an incoming entity with an existing one,
 * this function appends (or prepends) the items from the incoming page
 * onto the existing items, instead of replacing them.
 *
 * @example
 * ```typescript
 * import { defineEntity } from 'pinia-colada-plugin-normalizer'
 * import { cursorPagination } from 'pinia-colada-plugin-normalizer'
 *
 * const contactFeed = defineEntity<ContactFeed>({
 *   idField: 'feedId',
 *   merge: cursorPagination({
 *     getCursor: (feed) => feed.endCursor,
 *     itemsField: 'contacts',
 *     direction: 'forward',
 *   }),
 * })
 * ```
 */
export function cursorPagination<T extends EntityRecord = EntityRecord>(
  options: CursorPaginationOptions<T>,
): (existing: T, incoming: T) => T {
  const {
    getCursor,
    itemsField = "items",
    direction = "forward",
    dedupeKey,
  } = options;

  return (existing: T, incoming: T): T => {
    const existingItems = (existing[itemsField] as unknown[] | undefined) ?? [];
    const incomingItems = (incoming[itemsField] as unknown[] | undefined) ?? [];

    // If cursors match, this is a refresh of the same page — replace
    const existingCursor = getCursor(existing);
    const incomingCursor = getCursor(incoming);
    if (existingCursor != null && existingCursor === incomingCursor) {
      return { ...existing, ...incoming };
    }

    // Merge items based on direction
    let mergedItems: unknown[];
    if (direction === "backward") {
      mergedItems = [...incomingItems, ...existingItems];
    } else {
      mergedItems = [...existingItems, ...incomingItems];
    }

    // Deduplicate if requested
    if (dedupeKey) {
      const seen = new Set<unknown>();
      // Walk backwards so later items win
      for (let i = mergedItems.length - 1; i >= 0; i--) {
        const item = mergedItems[i];
        if (item != null && typeof item === "object") {
          const key = (item as Record<string, unknown>)[dedupeKey];
          if (key != null) {
            if (seen.has(key)) {
              mergedItems.splice(i, 1);
            } else {
              seen.add(key);
            }
          }
        }
      }
    }

    return {
      ...existing,
      ...incoming,
      [itemsField]: mergedItems,
    } as T;
  };
}

// ─────────────────────────────────────────────
// Offset-based Pagination
// ─────────────────────────────────────────────

/**
 * Options for offset-based pagination merge.
 */
export interface OffsetPaginationOptions<T extends EntityRecord = EntityRecord> {
  /**
   * Extract the current offset from the entity.
   *
   * @example
   * getOffset: (list) => list.offset
   */
  getOffset: (entity: T) => number;

  /**
   * Page size — used to determine where incoming items should be placed
   * in the merged array when offsets overlap.
   */
  pageSize: number;

  /**
   * The field on the entity that contains the items array.
   * @default 'items'
   */
  itemsField?: string;

  /**
   * Whether to deduplicate items by a key field.
   * @default undefined (no dedup)
   */
  dedupeKey?: string;
}

/**
 * Creates a merge function for offset-based pagination.
 *
 * Returns a merge function suitable for `defineEntity({ merge })`.
 * When the entity store merges an incoming entity with an existing one,
 * this function places incoming items at the correct offset position
 * within the existing items array.
 *
 * @example
 * ```typescript
 * import { defineEntity } from 'pinia-colada-plugin-normalizer'
 * import { offsetPagination } from 'pinia-colada-plugin-normalizer'
 *
 * const contactList = defineEntity<ContactList>({
 *   idField: 'listId',
 *   merge: offsetPagination({
 *     getOffset: (list) => list.offset,
 *     pageSize: 20,
 *     itemsField: 'contacts',
 *   }),
 * })
 * ```
 */
export function offsetPagination<T extends EntityRecord = EntityRecord>(
  options: OffsetPaginationOptions<T>,
): (existing: T, incoming: T) => T {
  const {
    getOffset,
    pageSize: _pageSize,
    itemsField = "items",
    dedupeKey,
  } = options;

  return (existing: T, incoming: T): T => {
    const existingItems = (existing[itemsField] as unknown[] | undefined) ?? [];
    const incomingItems = (incoming[itemsField] as unknown[] | undefined) ?? [];
    const existingOffset = getOffset(existing);
    const incomingOffset = getOffset(incoming);

    // If same offset, this is a refresh — replace the page
    if (existingOffset === incomingOffset) {
      return { ...existing, ...incoming };
    }

    // Place incoming items at the correct position.
    // Start with a copy of existing items, then overlay incoming at offset.
    const maxLen = Math.max(
      existingOffset + existingItems.length,
      incomingOffset + incomingItems.length,
    );
    const merged: unknown[] = Array.from({ length: maxLen });

    // Fill with existing items at their offset
    for (let i = 0; i < existingItems.length; i++) {
      merged[existingOffset + i] = existingItems[i];
    }

    // Overlay incoming items at their offset
    for (let i = 0; i < incomingItems.length; i++) {
      merged[incomingOffset + i] = incomingItems[i];
    }

    // Remove undefined gaps (sparse array cleanup)
    let mergedItems = merged.filter((item) => item !== undefined);

    // Deduplicate if requested
    if (dedupeKey) {
      const seen = new Set<unknown>();
      for (let i = mergedItems.length - 1; i >= 0; i--) {
        const item = mergedItems[i];
        if (item != null && typeof item === "object") {
          const key = (item as Record<string, unknown>)[dedupeKey];
          if (key != null) {
            if (seen.has(key)) {
              mergedItems.splice(i, 1);
            } else {
              seen.add(key);
            }
          }
        }
      }
    }

    // Use the incoming entity's metadata (offset, total, etc.) but keep merged items
    return {
      ...existing,
      ...incoming,
      [itemsField]: mergedItems,
    } as T;
  };
}

// ─────────────────────────────────────────────
// Relay-style Pagination (GraphQL Connection Spec)
// ─────────────────────────────────────────────

/**
 * Options for Relay-style connection pagination merge.
 */
export interface RelayPaginationOptions {
  /**
   * The field on the entity containing the edges array.
   * @default 'edges'
   */
  edgesField?: string;

  /**
   * The field on the entity containing the pageInfo object.
   * @default 'pageInfo'
   */
  pageInfoField?: string;

  /**
   * Merge direction.
   * - 'forward': append new edges after existing (default, for `after` cursors)
   * - 'backward': prepend new edges before existing (for `before` cursors)
   * @default 'forward'
   */
  direction?: "forward" | "backward";

  /**
   * Whether to deduplicate edges by cursor value.
   * When true, edges with the same cursor are kept only once
   * (the newer version wins).
   * @default true
   */
  dedupeByCursor?: boolean;
}

/**
 * Merge function for Relay-style GraphQL connection pagination.
 * Merges edges, deduplicates by cursor, and stitches `pageInfo`.
 *
 * @example
 * ```typescript
 * defineEntity<UsersConnection>({
 *   idField: 'connectionId',
 *   merge: relayPagination(),
 * })
 * ```
 */
export function relayPagination<T extends EntityRecord = EntityRecord>(
  options: RelayPaginationOptions = {},
): (existing: T, incoming: T) => T {
  const {
    edgesField = "edges",
    pageInfoField = "pageInfo",
    direction = "forward",
    dedupeByCursor = true,
  } = options;

  return (existing: T, incoming: T): T => {
    const existingEdges = (existing[edgesField] as unknown[] | undefined) ?? [];
    const incomingEdges = (incoming[edgesField] as unknown[] | undefined) ?? [];
    const existingPageInfo = existing[pageInfoField] as RelayPageInfo | undefined;
    const incomingPageInfo = incoming[pageInfoField] as RelayPageInfo | undefined;

    // No existing edges → first page, just accept incoming
    if (existingEdges.length === 0) {
      return { ...existing, ...incoming };
    }

    // No incoming edges → empty page (end of list), update pageInfo only
    if (incomingEdges.length === 0) {
      return {
        ...existing,
        ...incoming,
        [edgesField]: existingEdges,
      } as T;
    }

    // Merge edges based on direction
    let mergedEdges: unknown[];
    if (direction === "backward") {
      mergedEdges = [...incomingEdges, ...existingEdges];
    } else {
      mergedEdges = [...existingEdges, ...incomingEdges];
    }

    // Deduplicate by cursor (newer version wins)
    if (dedupeByCursor) {
      const seen = new Set<string>();
      for (let i = mergedEdges.length - 1; i >= 0; i--) {
        const edge = mergedEdges[i];
        if (edge != null && typeof edge === "object") {
          const cursor = (edge as Record<string, unknown>).cursor;
          if (typeof cursor === "string") {
            if (seen.has(cursor)) {
              mergedEdges.splice(i, 1);
            } else {
              seen.add(cursor);
            }
          }
        }
      }
    }

    // Stitch pageInfo: forward keeps existing start + incoming end,
    // backward keeps incoming start + existing end
    let mergedPageInfo: RelayPageInfo | undefined;
    if (existingPageInfo || incomingPageInfo) {
      if (direction === "forward") {
        mergedPageInfo = {
          startCursor: existingPageInfo?.startCursor ?? incomingPageInfo?.startCursor ?? null,
          endCursor: incomingPageInfo?.endCursor ?? existingPageInfo?.endCursor ?? null,
          hasPreviousPage: existingPageInfo?.hasPreviousPage ?? incomingPageInfo?.hasPreviousPage ?? false,
          hasNextPage: incomingPageInfo?.hasNextPage ?? existingPageInfo?.hasNextPage ?? false,
        };
      } else {
        mergedPageInfo = {
          startCursor: incomingPageInfo?.startCursor ?? existingPageInfo?.startCursor ?? null,
          endCursor: existingPageInfo?.endCursor ?? incomingPageInfo?.endCursor ?? null,
          hasPreviousPage: incomingPageInfo?.hasPreviousPage ?? existingPageInfo?.hasPreviousPage ?? false,
          hasNextPage: existingPageInfo?.hasNextPage ?? incomingPageInfo?.hasNextPage ?? false,
        };
      }
    }

    return {
      ...existing,
      ...incoming,
      [edgesField]: mergedEdges,
      ...(mergedPageInfo ? { [pageInfoField]: mergedPageInfo } : {}),
    } as T;
  };
}
