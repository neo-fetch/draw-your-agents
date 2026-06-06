# Design — Nested pydantic models inside schemas (feature #2)

**Status:** architect design note (no code). The implementing session(s) build against this and
append their own build-record ADR(s) to [DECISIONS.md](DECISIONS.md) (next in sequence after the
node-rename slice). This is the cold-start artifact the slice prompt points at.

**Goal:** let a schema field's type be **another declared schema**, not just a scalar — so a user
can build `class Order(BaseModel): customer: Customer` graphically. Today `SchemaField.type` is
`ScalarType` only, and the schema editor (ADR-0035) offers only the six scalars.

**This deliberately breaks the "frozen `packages/*`" rule** — it is a genuine type-system change
to the IR keystone, validator, and codegen. Golden tests + an ADK/pydantic fidelity check come
back into play (the verification posture of Phase 0).

---

## What exists today (grounding)

- `SchemaField.type: ScalarType` ([packages/ir/src/types.ts](../packages/ir/src/types.ts)); JSON
  schema pins it to the `scalarType` enum (`packages/ir/schema/ir.schema.json`).
- Codegen `renderSchema` ([packages/codegen/src/fragments.ts](../packages/codegen/src/fragments.ts))
  maps every field through `scalarType(field.type)` — it has no concept of a schema-typed field.
- `schemasModule` ([packages/codegen/src/project.ts](../packages/codegen/src/project.ts)) emits
  schemas in **array order** (`walkAllSchemas`). Fine today because schemas never reference each
  other; **nested models need declared-before-referenced ordering.**
- The validator already has `refOk(ref)` ([packages/ir/src/validate.ts](../packages/ir/src/validate.ts))
  = "is this `str`, `null`-where-allowed, or a declared schema name?" — directly reusable for field
  types. It also has `DUPLICATE_SCHEMA_NAME` and a per-schema `schemaFields` map.

## Decisions

1. **`SchemaField.type` becomes a `TypeRef`** — a scalar **or** the name of another declared
   schema. (`"str"` stays the spelled-out scalar; a capitalized identifier that resolves to a
   schema is a nested model.) JSON schema: `field.type` widens from the `scalarType` enum to
   `{ anyOf: [ scalarType, identifier ] }`. No new field — the existing `type` string carries it,
   mirroring how `inputType`/`outputType` already mean "scalar or schema name."
2. **Validator gains two checks (new codes):**
   - `UNKNOWN_FIELD_TYPE` — a field `type` that is neither a scalar nor a declared schema (reuse
     `refOk`, but scalars are also valid here, so a small `fieldTypeOk` wrapper).
   - `SCHEMA_FIELD_CYCLE` — schema-to-schema field references must form a **DAG**. A cycle
     (`A.b: B`, `B.a: A`) is rejected in v1: it can't be emitted in simple declared-before-used
     order and pydantic would need forward-ref `model_rebuild()` plumbing we're not generating yet.
     (Self-reference is the degenerate cycle and is likewise rejected.) Detect with a DFS over the
     schema dependency graph, scoped per namespace level (ADR-0017 flat global names still hold).
3. **Codegen:**
   - `renderSchema` resolves each field type: scalar → as today; schema name → the **class name**
     as the annotation. **No import needed** — nested models live in the same `schemas.py` module.
     `Optional[...]` / `= None` wrapping is unchanged and composes (`Optional[Customer]`).
   - `schemasModule` emits schemas in **topological order** (dependencies first), computed from the
     field-reference DAG the validator already proved acyclic. This is the one real codegen change
     beyond `renderSchema`; pin it with a golden test where `B` references `A` but appears first in
     the IR array — output must still declare `A` before `B`.
4. **Schema editor UI (ADR-0035 `SchemaPanel`):** the field-type `<select>` lists the six scalars
   **plus every declared schema name** (excluding the schema being edited, to avoid the obvious
   self-cycle at the UI level — deeper cycles are surfaced by the validator in Preview, not
   re-implemented in the UI). Reuses the existing `updateField(... {type})` reducer unchanged — the
   value is just a schema name now.
5. **No generics/lists/unions/dicts in v1.** A field is one scalar or one schema (optionally
   `Optional`). `list[X]` / `dict` / unions are a later extension; note it.

## Verification

- **Golden tests** (codegen spec): a new fixture (e.g. `nested-schema.ir.json`) with `Order`
  referencing `Customer`; assert `schemas.py` declares `Customer` before `Order`, the field reads
  `customer: Customer`, and `Optional[Customer] = None` for an optional nested field.
- **Validator spec tests**: `UNKNOWN_FIELD_TYPE` for a bogus type; `SCHEMA_FIELD_CYCLE` for
  `A↔B` and for self-reference; a valid nested DAG passes.
- **Fidelity** (low risk — nested pydantic is standard): extend the ADR-0021 check so the
  nested-schema fixture's `schemas.py` imports + the models instantiate under real
  `google-adk==2.0.0`/pydantic. The user runs it.
- **UI**: build + browser — add `Customer`, add `Order` with a `customer` field whose type select
  shows `Customer`, Preview's `schemas.py` shows both in dependency order; introduce a cycle and
  watch Preview flag `SCHEMA_FIELD_CYCLE`.

## Slice plan

- **Slice 2-A (packages): nested field types.** Widen `SchemaField.type` + JSON schema; add
  `fieldTypeOk` + `UNKNOWN_FIELD_TYPE` + `SCHEMA_FIELD_CYCLE` to the validator; `renderSchema`
  schema-typed annotations; `schemasModule` topological emission; new golden fixture + validator
  spec tests; extend fidelity. Ends green on `npm test`. Appends an ADR.
- **Slice 2-B (web): schema-typed field select.** `SchemaPanel` field-type `<select>` offers
  declared schema names (minus self); headless test that choosing a schema name flows through
  `updateField` → `compile()` emits the nested annotation; browser verify. Appends an ADR.

(2-A before 2-B: the editor can't offer a capability the IR/codegen don't yet support.)

## Out of scope (noted, not regressions)
Recursive/forward-ref models (cycles), `list[...]`/`dict`/union field types, nested-schema authoring
*inside* a nested `workflow.config.graph` (top-level `ir.schemas` only, consistent with deferred
nested-graph editing).
