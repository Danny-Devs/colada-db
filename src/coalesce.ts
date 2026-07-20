/**
 * Batches multiple items and flushes them together after a delay.
 *
 * Use this when real-time events signal "entity X changed" without
 * carrying the full data. Instead of one fetch per event, coalesce
 * them into a single batch fetch.
 *
 * Extracted from pinia-colada-plugin-normalizer's composables.ts
 * (chip 2.5, 2026-07-19); logic unchanged.
 *
 * @example
 * ```typescript
 * const coalescer = createCoalescer(async (entityKeys) => {
 *   const entities = await api.fetchEntitiesByIds(entityKeys)
 *   for (const entity of entities) {
 *     store.set('contact', entity.id, entity)
 *   }
 * }, 100) // 100ms window
 *
 * ws.on('ENTITY_STALE', ({ key }) => coalescer.add(key))
 * ```
 */
export function createCoalescer<T = string>(
  onFlush: (items: T[]) => void | Promise<void>,
  delay = 50,
): { add: (item: T) => void; flush: () => void } {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function add(item: T) {
    pending.push(item);
    if (!timer) {
      timer = setTimeout(flush, delay);
    }
  }

  function flush() {
    const batch = pending;
    pending = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (batch.length > 0) {
      onFlush(batch);
    }
  }

  return { add, flush };
}
