/**
 * DAN-648 — encode/decodeEntityRefs serialization-integrity regressions.
 *
 * Three findings from the DAN-648 adversarial sweep, each re-vetted here with
 * a repro that FAILS against the pre-fix code:
 *
 * M1 — the ref-REBUILD path (`result[key] = value`) triggers the `__proto__`
 *      accessor when an object carries an OWN enumerable `__proto__` key (as
 *      JSON.parse'd / persisted data does) alongside a sibling EntityRef. The
 *      field is silently dropped AND the rebuilt object inherits from the
 *      supplied data. Prototype-pollution-adjacent.
 * M2 — decode treats any `{__cdb_ref:true, ...}`-shaped object as a ref even
 *      when the ref fields are missing or the wrong type, hydrating malformed /
 *      dangling refs out of ordinary persisted data.
 * M3 — encode preserves `undefined`-valued fields, so the same entity
 *      serializes one way through structured-clone (IDB) and another through
 *      JSON (SQLite). Pinned here as the documented divergence envelope.
 */
import { describe, expect, it } from "vitest";
import { createEntityStore, encodeEntityRefs, decodeEntityRefs } from "./store";
import { denormalize } from "./normalize";
import { ENTITY_REF_MARKER } from "./types";
import type { EntityRef } from "./types";

const wireRef = (entityType: string, id: string) => ({
  __cdb_ref: true,
  entityType,
  id,
  key: `${entityType}:${id}`,
});

const memRef = (entityType: string, id: string): EntityRef => ({
  [ENTITY_REF_MARKER]: true,
  entityType,
  id,
  key: `${entityType}:${id}` as EntityRef["key"],
});

describe("DAN-648 M1 — __proto__ own-key survives the ref-rebuild path", () => {
  it("encode: object with own __proto__ + sibling ref keeps __proto__ as own enumerable prop", () => {
    const input = JSON.parse('{"id":"z","__proto__":{"evil":1}}') as Record<string, unknown>;
    input.author = memRef("contact", "42");

    const encoded = encodeEntityRefs(input) as Record<string, unknown>;

    // Field must survive as an OWN enumerable property, not be swallowed by the setter.
    expect(Object.prototype.hasOwnProperty.call(encoded, "__proto__")).toBe(true);
    expect(Object.keys(encoded)).toContain("__proto__");
    // Prototype must remain the ordinary Object.prototype — no pollution.
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
    // The supplied payload must NOT be inherited as data.
    expect((encoded as { evil?: unknown }).evil).toBeUndefined();
    // Sibling ref still encoded to wire form.
    expect((encoded.author as Record<string, unknown>).__cdb_ref).toBe(true);
  });

  it("decode: wire object with own __proto__ + sibling ref keeps __proto__ as own enumerable prop", () => {
    const wire = JSON.parse(
      '{"id":"z","__proto__":{"evil":1},"author":{"__cdb_ref":true,"entityType":"contact","id":"42","key":"contact:42"}}',
    ) as Record<string, unknown>;

    const decoded = decodeEntityRefs(wire) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(decoded, "__proto__")).toBe(true);
    expect(Object.keys(decoded)).toContain("__proto__");
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect((decoded as { evil?: unknown }).evil).toBeUndefined();
    expect((decoded.author as Record<string | symbol, unknown>)[ENTITY_REF_MARKER]).toBe(true);
  });

  it("M1 nested: __proto__ inside a nested object on the rebuild path survives", () => {
    const wire = JSON.parse(
      '{"outer":{"__proto__":{"evil":1},"child":{"__cdb_ref":true,"entityType":"c","id":"1","key":"c:1"}}}',
    ) as Record<string, unknown>;

    const decoded = decodeEntityRefs(wire) as Record<string, unknown>;
    const outer = decoded.outer as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(outer, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(outer)).toBe(Object.prototype);
    expect((outer as { evil?: unknown }).evil).toBeUndefined();
  });

  it("M1 array element: __proto__ in an object inside an array with a ref survives", () => {
    const wire = JSON.parse(
      '[{"__proto__":{"evil":1},"r":{"__cdb_ref":true,"entityType":"c","id":"1","key":"c:1"}}]',
    ) as unknown[];

    const decoded = decodeEntityRefs(wire) as Array<Record<string, unknown>>;
    const el = decoded[0];

    expect(Object.prototype.hasOwnProperty.call(el, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(el)).toBe(Object.prototype);
    expect((el as { evil?: unknown }).evil).toBeUndefined();
  });

  it("M1 self-review: constructor / prototype own keys survive as own props on rebuild", () => {
    const wire = JSON.parse(
      '{"constructor":"c-val","prototype":"p-val","r":{"__cdb_ref":true,"entityType":"c","id":"1","key":"c:1"}}',
    ) as Record<string, unknown>;

    const decoded = decodeEntityRefs(wire) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(decoded, "constructor")).toBe(true);
    expect(decoded.constructor).toBe("c-val");
    expect(Object.prototype.hasOwnProperty.call(decoded, "prototype")).toBe(true);
    expect(decoded.prototype).toBe("p-val");
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it("M1 control: no-ref short-circuit returns the input untouched (bug is rebuild-only)", () => {
    const noRef = JSON.parse('{"id":"z","__proto__":{"evil":1}}') as Record<string, unknown>;
    const encoded = encodeEntityRefs(noRef);
    // No sibling ref → identity return, original object (with its own __proto__) untouched.
    expect(encoded).toBe(noRef);
  });

  it("M1 symmetry: encode → JSON → decode preserves __proto__ own key and restores the ref", () => {
    const mem = JSON.parse('{"id":"z","__proto__":{"nested":1}}') as Record<string, unknown>;
    mem.author = memRef("c", "1");

    const roundTripped = decodeEntityRefs(
      JSON.parse(JSON.stringify(encodeEntityRefs(mem))),
    ) as Record<string | symbol, unknown>;

    expect(Object.prototype.hasOwnProperty.call(roundTripped, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(roundTripped)).toBe(Object.prototype);
    expect((roundTripped.author as Record<string | symbol, unknown>)[ENTITY_REF_MARKER]).toBe(true);
  });
});

describe("DAN-648 M2 — decode validates the full ref shape", () => {
  it("legitimate wire ref still round-trips", () => {
    const decoded = decodeEntityRefs(wireRef("contact", "42")) as Record<string | symbol, unknown>;
    expect(decoded[ENTITY_REF_MARKER]).toBe(true);
    expect(decoded.entityType).toBe("contact");
    expect(decoded.id).toBe("42");
    expect(decoded.key).toBe("contact:42");
  });

  it("legitimate wire ref with extra fields still round-trips as a ref", () => {
    const decoded = decodeEntityRefs({ ...wireRef("contact", "42"), extra: 1 }) as Record<
      string | symbol,
      unknown
    >;
    expect(decoded[ENTITY_REF_MARKER]).toBe(true);
    expect(decoded.entityType).toBe("contact");
  });

  it("__cdb_ref-shaped data missing id must NOT become a ref (stays plain data)", () => {
    const plain = { __cdb_ref: true, entityType: "foo", key: "foo:bar" };
    const decoded = decodeEntityRefs(plain) as Record<string | symbol, unknown>;
    expect(decoded[ENTITY_REF_MARKER]).toBeUndefined();
    expect(decoded.__cdb_ref).toBe(true);
    expect(decoded.entityType).toBe("foo");
  });

  it("__cdb_ref-shaped data with wrong-typed fields must NOT become a ref", () => {
    const plain = { __cdb_ref: true, entityType: 123, id: {}, key: ["x"] };
    const decoded = decodeEntityRefs(plain) as Record<string | symbol, unknown>;
    expect(decoded[ENTITY_REF_MARKER]).toBeUndefined();
    expect(decoded.entityType).toBe(123);
  });

  it("__cdb_ref !== true is never a ref", () => {
    const plain = { __cdb_ref: "yes", entityType: "foo", id: "bar", key: "foo:bar" };
    const decoded = decodeEntityRefs(plain) as Record<string | symbol, unknown>;
    expect(decoded[ENTITY_REF_MARKER]).toBeUndefined();
  });
});

describe("DAN-648 M3 — undefined-field serialization divergence (pinned)", () => {
  it("encode preserves undefined-valued fields; JSON drops them, structured-clone keeps them", () => {
    const encoded = encodeEntityRefs({ a: 1, b: undefined }) as Record<string, unknown>;

    // Documented behavior: encode keeps the key (it is a pure ref transform, not a JSON filter).
    expect(Object.prototype.hasOwnProperty.call(encoded, "b")).toBe(true);

    // The engine-serialization divergence this documents:
    expect(JSON.parse(JSON.stringify(encoded))).not.toHaveProperty("b"); // SQLite/JSON drops
    expect(structuredClone(encoded)).toHaveProperty("b"); // IDB/structured-clone keeps
  });
});

/**
 * DAN-649 (gauntlet FIX 8 / FIX 9) — the ref-identity contract.
 *
 * `ENTITY_REF_MARKER` moved from a per-instance `Symbol()` to a GLOBAL registry
 * key, `Symbol.for("colada-db/entity-ref@1")`, so two copies of colada-db on one
 * page agree on ref identity. That fixed a real defect and introduced a new
 * coupling: a global registry interns across VERSIONS as well as across
 * instances.
 *
 * Two consequences are pinned here.
 *
 * FIX 8 — the key is VERSIONED. Without the `@1` suffix, a page holding v1 and
 * v2 would have v1's `isEntityRef` accept a v2 ref. The plain `Symbol()` this
 * replaced degraded such cross-version refs safely to opaque data; the suffix
 * restores that fail-safe. Bump it on any breaking change to the ref SHAPE.
 *
 * FIX 9 — encode and decode must distrust the SAME things. Decode has validated
 * the full ref shape since DAN-648/M2; encode and `isEntityRef` checked only the
 * marker. While the marker was per-instance that asymmetry was latent: a
 * foreign-shaped ref could not carry a matching symbol, so it never reached the
 * encode branch. Under a global registry it can — and an unvalidated encode
 * would destructively rewrite it into a malformed `__cdb_ref` row that decode's
 * own M2 guard then permanently refuses, turning a clean round-trip into an
 * unrecoverable relationship.
 *
 * Severity, honestly: the destructive path needs two colada-db copies with
 * DIFFERENT ref shapes on one page, i.e. a future major. The package is 0.1.0,
 * private, with zero users on disk. This closes a future hazard while it is
 * free — it is not a live bug.
 */
describe("DAN-649 FIX 8 — the ref marker is a VERSIONED global registry key", () => {
  it("is the interned symbol for `colada-db/entity-ref@1`", () => {
    expect(ENTITY_REF_MARKER).toBe(Symbol.for("colada-db/entity-ref@1"));
    expect(Symbol.keyFor(ENTITY_REF_MARKER)).toBe("colada-db/entity-ref@1");
  });

  it("a duplicate copy of the SAME major agrees on ref identity (the benefit kept)", () => {
    // What another copy of this same version would mint, independently.
    const fromAnotherCopy = {
      [Symbol.for("colada-db/entity-ref@1")]: true,
      entityType: "contact",
      id: "42",
      key: "contact:42",
    };
    const encoded = encodeEntityRefs(fromAnotherCopy) as Record<string, unknown>;
    expect(encoded).toEqual(wireRef("contact", "42"));
  });

  it("a FUTURE major's marker does not intern with this one (the fail-safe restored)", () => {
    const fromNextMajor = {
      [Symbol.for("colada-db/entity-ref@2")]: true,
      entityType: "contact",
      id: "42",
    };
    expect(Symbol.for("colada-db/entity-ref@2")).not.toBe(ENTITY_REF_MARKER);
    // Opaque data, walked as an ordinary object — never mistaken for a v1 ref.
    const encoded = encodeEntityRefs(fromNextMajor) as Record<string, unknown>;
    expect(encoded.__cdb_ref).toBeUndefined();
    expect(encoded.entityType).toBe("contact");
  });

  it("emitted bytes for a legitimate ref are unchanged by the rename (no migration)", () => {
    // The symbol VALUE is never serialized; it only gates the encode branch.
    // Single-instance disk content must therefore be byte-identical.
    expect(JSON.stringify(encodeEntityRefs(memRef("contact", "42")))).toBe(
      '{"__cdb_ref":true,"entityType":"contact","id":"42","key":"contact:42"}',
    );
  });
});

describe("DAN-649 FIX 9 — encode distrusts exactly what decode distrusts", () => {
  it("a marked object with a FOREIGN shape passes through as plain data, not a ref", () => {
    // A ref minted by another copy whose shape this build does not recognise —
    // no `id`, and `key` is structured rather than a string.
    const foreign = {
      [ENTITY_REF_MARKER]: true,
      entityType: "contact",
      key: { type: "contact", id: "42" },
    };

    const encoded = encodeEntityRefs(foreign) as Record<string, unknown>;

    // NOT rewritten into a malformed `__cdb_ref` row.
    expect(encoded.__cdb_ref).toBeUndefined();
    // The payload survives intact and still round-trips.
    expect(encoded.entityType).toBe("contact");
    expect(encoded.key).toEqual({ type: "contact", id: "42" });
    expect(decodeEntityRefs(JSON.parse(JSON.stringify(encoded)))).toEqual({
      entityType: "contact",
      key: { type: "contact", id: "42" },
    });
  });

  it("pre-FIX-9 the same input produced a row decode's own M2 guard refuses", () => {
    // The unrecoverable state this closes, constructed explicitly: what the
    // unvalidated encode branch would have emitted for the object above.
    const wouldHaveBeenWritten = {
      __cdb_ref: true,
      entityType: "contact",
      id: undefined,
      key: { type: "contact", id: "42" },
    };
    const decoded = decodeEntityRefs(wouldHaveBeenWritten) as Record<string | symbol, unknown>;
    // Decode (correctly) refuses it — so the relationship is gone for good.
    expect(decoded[ENTITY_REF_MARKER]).toBeUndefined();
  });

  it("a marked object nested inside a payload also survives as plain data", () => {
    const input = {
      id: "z",
      good: memRef("contact", "42"),
      foreign: { [ENTITY_REF_MARKER]: true, entityType: 7, id: "x", key: "7:x" },
    };
    const encoded = encodeEntityRefs(input) as Record<string, Record<string, unknown>>;
    expect(encoded.good).toEqual(wireRef("contact", "42"));
    expect(encoded.foreign.__cdb_ref).toBeUndefined();
    expect(encoded.foreign.entityType).toBe(7);
  });

  it("legitimate refs are entirely unaffected (non-destructive)", () => {
    const ref = memRef("order", "7");
    expect(encodeEntityRefs(ref)).toEqual(wireRef("order", "7"));
    expect(decodeEntityRefs(encodeEntityRefs(ref))).toEqual(ref);
  });

  it("denormalize leaves a foreign-shaped marked object alone instead of erasing it", () => {
    // `isEntityRef` gates the DEREFERENCE. Before FIX 9 a marked object with a
    // non-string `entityType` took the ref branch, missed the store lookup, and
    // was replaced with `undefined` — silent data loss on the read path.
    const store = createEntityStore();
    const foreign = { [ENTITY_REF_MARKER]: true, entityType: 7, id: "x", key: "7:x" };
    const result = denormalize({ payload: foreign }, store) as Record<string, unknown>;
    // Structural sharing: nothing changed, so the payload comes back identical
    // — the whole point. Pre-FIX-9 it came back as `undefined`.
    expect(result.payload).toBe(foreign);
    expect(result.payload).not.toBeUndefined();
  });
});
