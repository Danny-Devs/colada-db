/**
 * The normalization engine — pure functions over the entity store.
 *
 * normalize():   walk a payload, extract entities, replace them with EntityRefs.
 * denormalize(): walk data, resolve EntityRefs back to live store entities
 *                with structural sharing and circular-ref protection.
 *
 * Extracted from pinia-colada-plugin-normalizer's plugin.ts (chip 2, 2026-07-19);
 * bodies unchanged.
 */
import type {
  EntityRecord,
  EntityRef,
  NormalizationResult,
  EntityStore,
  EntityDefinition,
} from "./types";
import { ENTITY_REF_MARKER } from "./types";

/**
 * Split an entity key like 'contact:42' into ['contact', '42'].
 * @internal
 */
export function splitEntityKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}


/**
 * Write extracted entities to the store, respecting custom merge policies.
 * Entities with a custom merge function are processed individually;
 * the rest are batched for efficiency.
 * @internal
 */
export function writeEntitiesToStore(
  entities: NormalizationResult["entities"],
  entityDefs: Record<string, EntityDefinition>,
  store: EntityStore,
): void {
  const customMergeEntities = entities.filter(
    (e) => entityDefs[e.entityType]?.merge,
  );
  const regularEntities = entities.filter(
    (e) => !entityDefs[e.entityType]?.merge,
  );

  // Stamped `query-response` (ADR-007 §1): normalization of fetched server
  // data is the most common write path, and this function IS its channel.
  // A coordinator that writes normalized data under a different authority
  // (e.g., a Stage-3 sync adapter) uses its own store writes under its own
  // origin rather than routing through this stamp.
  store.runWith({ origin: "query-response" }, () => {
    if (regularEntities.length > 0) {
      store.setMany(regularEntities);
    }
    for (const entity of customMergeEntities) {
      const mergeFn = entityDefs[entity.entityType].merge!;
      // Atomic read-modify-write: the merge runs inside the store so an
      // interleaved write (sync loop, async backend) can't land between the
      // read and the write and get silently lost.
      store.update(entity.entityType, entity.id, (existing) =>
        existing ? mergeFn(existing, entity.data) : entity.data,
      );
    }
  });
}

// ─────────────────────────────────────────────
// Normalization Engine
// ─────────────────────────────────────────────

/**
 * Walks a data structure, extracts entities (objects with IDs),
 * and replaces them with EntityRef references.
 *
 * Non-entity data (no ID field, deeply nested hierarchies) is left as-is.
 * This is the "hybrid" approach — normalize selectively.
 *
 * Uses a WeakSet for circular reference detection (Issue #12 fix).
 * @internal
 */
export function normalize(
  data: unknown,
  entityDefs: Record<string, EntityDefinition>,
  defaultIdField: string,
): NormalizationResult {
  const extractedEntities: NormalizationResult["entities"] = [];
  const visited = new WeakSet<object>();

  const normalized = walkAndNormalize(data, entityDefs, defaultIdField, extractedEntities, visited);

  return { normalized, entities: extractedEntities };
}

function walkAndNormalize(
  data: unknown,
  entityDefs: Record<string, EntityDefinition>,
  defaultIdField: string,
  extracted: NormalizationResult["entities"],
  visited: WeakSet<object>,
): unknown {
  // Null / undefined / primitives — pass through
  if (data == null || typeof data !== "object") {
    return data;
  }

  // Circular reference protection (Issue #12 fix)
  if (visited.has(data)) {
    return data; // Return as-is, don't recurse
  }
  visited.add(data);

  // Arrays — walk each element
  if (Array.isArray(data)) {
    return data.map((item) =>
      walkAndNormalize(item, entityDefs, defaultIdField, extracted, visited),
    );
  }

  // Objects — check if this is an entity
  const record = data as EntityRecord;
  const entityInfo = identifyEntity(record, entityDefs, defaultIdField);

  if (entityInfo) {
    const { entityType, id } = entityInfo;

    // Recursively normalize nested entities within this entity
    const normalizedEntity: EntityRecord = {};
    for (const [key, value] of Object.entries(record)) {
      normalizedEntity[key] = walkAndNormalize(
        value,
        entityDefs,
        defaultIdField,
        extracted,
        visited,
      );
    }

    // Extract the entity
    extracted.push({ entityType, id, data: normalizedEntity });

    // Replace with a reference (using Symbol marker, Issue #13 fix)
    const ref: EntityRef = {
      [ENTITY_REF_MARKER]: true,
      entityType,
      id,
      key: `${entityType}:${id}`,
    };
    return ref;
  }

  // Not an entity — walk children but keep the structure intact
  const result: EntityRecord = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = walkAndNormalize(value, entityDefs, defaultIdField, extracted, visited);
  }
  return result;
}

/**
 * Determines if an object is an entity and extracts its type and ID.
 *
 * Resolution order:
 * 1. Check explicit entityDefs (by matching field names or getId function)
 * 2. Fall back to convention (has `defaultIdField` → entity)
 *    BUT only if the entity type can be determined (via __typename or entityDefs).
 *    Generic fallback to 'entity' type is DISABLED to prevent ID collisions
 *    between unrelated objects (Issue #7, #11 fix).
 *
 * Returns null if the object is not an entity.
 */
function identifyEntity(
  record: EntityRecord,
  entityDefs: Record<string, EntityDefinition>,
  defaultIdField: string,
): { entityType: string; id: string } | null {
  // Check explicit definitions first
  for (const [entityType, def] of Object.entries(entityDefs)) {
    if (def.getId) {
      const id = def.getId(record);
      if (id != null) return { entityType, id: String(id) };
    }
    if (def.idField && record[def.idField] != null) {
      return { entityType, id: String(record[def.idField]) };
    }
  }

  // Convention-based: look for the default ID field
  if (record[defaultIdField] != null) {
    // Only auto-detect if we can determine the type.
    // __typename is the GraphQL convention.
    // Without a type, we SKIP auto-detection to prevent ID collisions
    // between unrelated objects (e.g., user id:1 vs order id:1).
    if (typeof record.__typename === "string") {
      return { entityType: record.__typename, id: String(record[defaultIdField]) };
    }
    // No type information available — skip normalization for this object.
    // Users should use defineEntity() for REST APIs without __typename.
    return null;
  }

  return null;
}

// ─────────────────────────────────────────────
// Denormalization Engine (recursive)
// ─────────────────────────────────────────────

/**
 * Denormalizes data by recursively replacing EntityRef references with live
 * entity data from the store.
 *
 * Used on the read path (customRef getter) and available as a public utility.
 * Entities in the store may themselves contain EntityRefs (nested entities),
 * so denormalization must be recursive.
 *
 * Supports structural sharing via an optional cache parameter: when provided,
 * returns the same object reference for entities whose ShallowRef value hasn't
 * changed — preventing unnecessary re-renders.
 *
 * Uses store.has() before store.get() to avoid creating phantom refs.
 * Uses a WeakSet for circular reference protection.
 * @internal
 */
export function denormalize(
  data: unknown,
  store: EntityStore,
  cache?: Map<string, { entity: EntityRecord; result: unknown }>,
): unknown {
  const visited = new WeakSet<object>();
  return walkAndDenormalize(data, store, visited, cache);
}

function walkAndDenormalize(
  data: unknown,
  store: EntityStore,
  visited: WeakSet<object>,
  cache?: Map<string, { entity: EntityRecord; result: unknown }>,
): unknown {
  if (data == null || typeof data !== "object") {
    return data;
  }

  if (visited.has(data as object)) {
    return data;
  }
  visited.add(data as object);

  if (Array.isArray(data)) {
    let changed = false;
    const result = data.map((item) => {
      const newItem = walkAndDenormalize(item, store, visited, cache);
      if (newItem !== item) changed = true;
      return newItem;
    });
    // Backtrack: allow this array to be revisited from other paths.
    // Circular refs are still caught because the array is in `visited`
    // during its own subtree traversal.
    visited.delete(data);
    return changed ? result : data;
  }

  const record = data as Record<string | symbol, unknown>;
  if (isEntityRef(record)) {
    const entityType = record.entityType as string;
    const id = record.id as string;

    // Check existence first to avoid creating phantom refs
    if (!store.has(entityType, id)) return undefined;

    // Read the ShallowRef — tracked by the outer computed for reactivity
    const entity = store.get(entityType, id).value;
    if (entity == null) return undefined;

    // Structural sharing: if cache provided and entity ref unchanged, reuse result
    if (cache) {
      const cacheKey = `${entityType}:${id}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.entity === entity) {
        return cached.result;
      }
      const result = walkAndDenormalize(entity, store, visited, cache);
      cache.set(cacheKey, { entity, result });
      return result;
    }

    return walkAndDenormalize(entity, store, visited, cache);
  }

  // Walk children with structural sharing
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const newValue = walkAndDenormalize(value, store, visited, cache);
    result[key] = newValue;
    if (newValue !== value) changed = true;
  }
  // Backtrack: allow this object to be revisited from other ref paths.
  // Circular refs are still caught because the object is in `visited`
  // during its own subtree traversal.
  visited.delete(data as object);
  return changed ? result : data;
}

function isEntityRef(obj: Record<string | symbol, unknown>): boolean {
  return obj[ENTITY_REF_MARKER] === true;
}
