/**
 * Machine-legible schema export (ADR-007 §4) — the entity registry as
 * plain JSON. This export IS the future MCP resource / tool-definition
 * input (Stage 2c): an agent discovers the data model without reading
 * source. Also serves devtools and docs generation, which is how we know
 * it's architecture and not fashion.
 *
 * Honesty rules:
 * - Functions can't be exported. `getId`/`merge` become capability flags
 *   (`computedId`/`customMerge`) so a consumer knows the behavior exists
 *   without pretending to serialize it.
 * - Only DECLARED metadata appears (the runtime registry is type-erased);
 *   an undeclared type still exports a minimal, valid entry.
 * - The result is JSON-pure by construction: round-trips through
 *   JSON.stringify unchanged.
 */
import type { EntityDefinition } from "./types";

export interface ExportedField {
  type: string;
  description?: string;
}

export interface ExportedRelation {
  /** Target entity type of the EntityRef(s) in this field. */
  entity: string;
  /** True when the field holds an array of refs. */
  many: boolean;
  description?: string;
}

export interface ExportedEntitySchema {
  /** Declared id field; null when the id is computed (`getId`). */
  idField: string | null;
  /** True when the definition derives ids via a `getId` function. */
  computedId: boolean;
  /** True when the definition carries a custom merge function. */
  customMerge: boolean;
  /** True when this type never syncs to a server. */
  local: boolean;
  description?: string;
  fields: Record<string, ExportedField>;
  relations: Record<string, ExportedRelation>;
}

export interface ColadaDbSchema {
  /** Export format version — bump on breaking shape changes. */
  version: 1;
  /** The convention id field applied when a definition declares none. */
  defaultIdField: string;
  entities: Record<string, ExportedEntitySchema>;
}

/**
 * Export the runtime entity registry as plain JSON.
 *
 * @param entityDefs The registry passed to normalization (type → definition).
 * @param options.defaultIdField The convention default (`'id'` unless the
 *   host app overrides it) — echoed into the export so consumers can
 *   resolve types that rely on convention.
 */
export function exportSchema(
  entityDefs: Record<string, EntityDefinition>,
  options: { defaultIdField?: string } = {},
): ColadaDbSchema {
  const { defaultIdField = "id" } = options;
  const entities: Record<string, ExportedEntitySchema> = {};

  for (const [entityType, def] of Object.entries(entityDefs)) {
    const fields: Record<string, ExportedField> = {};
    for (const [name, spec] of Object.entries(def.fields ?? {})) {
      fields[name] = typeof spec === "string" ? { type: spec } : { ...spec };
    }

    const relations: Record<string, ExportedRelation> = {};
    for (const [name, rel] of Object.entries(def.relations ?? {})) {
      relations[name] = {
        entity: rel.entity,
        many: rel.many ?? false,
        ...(rel.description !== undefined && { description: rel.description }),
      };
    }

    entities[entityType] = {
      idField: def.getId ? null : (def.idField ?? null),
      computedId: def.getId != null,
      customMerge: def.merge != null,
      local: def.local ?? false,
      ...(def.description !== undefined && { description: def.description }),
      fields,
      relations,
    };
  }

  return { version: 1, defaultIdField, entities };
}
