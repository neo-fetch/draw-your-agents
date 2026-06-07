/**
 * Pure reducers for CRUD over `ir.schemas` (ADR-0035).
 *
 * Closes the schema-authoring gap deferred by ADR-0029 decision 6 / ADR-0030.
 * Joins the install-free reducer family alongside `irReducer.ts`, `addNode.ts`,
 * `irEdges.ts`, `insertVariable.ts`: React-free, zustand-free, no `lexical`,
 * IR types consumed type-only (ADR-0011 / ADR-0013 / ADR-0022).
 *
 * Scope: top-level `ir.schemas` only — nested `workflow.config.graph.schemas`
 * are out of scope, consistent with the nested-graph editing deferral across
 * ADR-0017 / ADR-0023 / ADR-0026 / ADR-0029. The UI never re-implements
 * validator rules (identifier validity / uniqueness — invariant 1, type-ref
 * resolution — invariant 5): Preview surfaces those findings honestly.
 */
import type {
  AgentNode,
  FunctionNode,
  GraphIR,
  GraphNode,
  HumanInputNode,
  InstructionSegment,
  RouterNode,
  ScalarType,
  SchemaDef,
  SchemaField,
  ToolNode,
  TypeRef,
} from "@graphical-agents/ir";

const SCALAR_TYPES: readonly ScalarType[] = [
  "str",
  "int",
  "float",
  "bool",
  "date",
  "datetime",
];

export function scalarTypes(): readonly ScalarType[] {
  return SCALAR_TYPES;
}

/**
 * Options for a field's type `<select>` in `SchemaPanel` (ADR-0038 / #2-B):
 * the six scalars followed by every declared schema name, **excluding
 * `selfName`** to block the degenerate self-cycle at the UI level. Deeper
 * cycles (`A → B → A`) are surfaced honestly by the validator's
 * `SCHEMA_FIELD_CYCLE` in Preview — we do not re-implement DAG detection here
 * (mirror-the-validator, ADR-0023 / ADR-0026).
 *
 * Pure helper so the headless oracle can pin candidate logic without a DOM.
 */
export function fieldTypeCandidates(
  schemas: readonly SchemaDef[],
  selfName: string,
): readonly TypeRef[] {
  return [
    ...SCALAR_TYPES,
    ...schemas.map((s) => s.name).filter((n) => n !== selfName),
  ];
}

function nextFree(prefix: string, taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Append a new schema with one default `field1: str`. A zero-field schema
 * compiles to `class X(BaseModel): pass` — start populated so the first thing
 * the user sees is a usable model.
 */
export function addSchema(ir: GraphIR): { ir: GraphIR; schemaName: string } {
  const taken = new Set(ir.schemas.map((s) => s.name));
  const schemaName = nextFree("Schema", taken);
  const fresh: SchemaDef = {
    name: schemaName,
    fields: [{ name: "field1", type: "str" }],
  };
  return {
    ir: { ...ir, schemas: [...ir.schemas, fresh] },
    schemaName,
  };
}

/**
 * Rename a schema AND cascade every top-level reference to it:
 *   agent inputSchemaRef / outputSchemaRef
 *   agent instruction.segments[].schema (var chips)
 *   function inputType / outputType
 *   router inputType
 *   tool inputType / outputType
 *   humanInput payloadRef / responseSchemaRef
 *
 * No-op (returns input IR ref) when `newName === oldName` or `oldName` doesn't
 * name a top-level schema. Identifier validity / uniqueness is the validator's
 * job (invariant 1) — Preview surfaces INVALID_SCHEMA_NAME /
 * DUPLICATE_SCHEMA_NAME if the user types something illegal.
 *
 * Cascade is top-level only — nested `workflow.config.graph.schemas` are out
 * of scope (consistent with the nested-graph editing deferral throughout the
 * UI). Field-name rename does NOT cascade into chips (see `updateField`).
 */
export function renameSchema(
  ir: GraphIR,
  oldName: string,
  newName: string,
): GraphIR {
  if (newName === oldName) return ir;
  if (!ir.schemas.some((s) => s.name === oldName)) return ir;

  const schemas = ir.schemas.map((s): SchemaDef =>
    s.name === oldName ? { ...s, name: newName } : s,
  );

  const mapRef = (ref: string | null | undefined): string | null | undefined =>
    ref === oldName ? newName : ref;

  const nodes = ir.nodes.map((n): GraphNode => renameRefsInNode(n, oldName, newName, mapRef));

  return { ...ir, schemas, nodes };
}

function renameRefsInNode(
  n: GraphNode,
  oldName: string,
  newName: string,
  mapRef: (ref: string | null | undefined) => string | null | undefined,
): GraphNode {
  switch (n.type) {
    case "agent": {
      const a = n as AgentNode;
      const inSeg = a.config.instruction.segments;
      let segmentsChanged = false;
      const nextSegments: InstructionSegment[] = inSeg.map((seg) => {
        if (seg.type === "var" && seg.schema === oldName) {
          segmentsChanged = true;
          return { ...seg, schema: newName };
        }
        return seg;
      });
      const nextInputRef = mapRef(a.config.inputSchemaRef);
      const nextOutputRef = mapRef(a.config.outputSchemaRef);
      const refsChanged =
        nextInputRef !== a.config.inputSchemaRef ||
        nextOutputRef !== a.config.outputSchemaRef;
      if (!segmentsChanged && !refsChanged) return n;
      return {
        ...a,
        config: {
          ...a.config,
          inputSchemaRef: nextInputRef,
          outputSchemaRef: nextOutputRef as string,
          instruction: segmentsChanged
            ? { segments: nextSegments }
            : a.config.instruction,
        },
      };
    }
    case "function": {
      const f = n as FunctionNode;
      const nIn = mapRef(f.config.inputType);
      const nOut = mapRef(f.config.outputType);
      if (nIn === f.config.inputType && nOut === f.config.outputType) return n;
      return {
        ...f,
        config: { ...f.config, inputType: nIn as string, outputType: nOut as string },
      };
    }
    case "tool": {
      const t = n as ToolNode;
      const nIn = mapRef(t.config.inputType);
      const nOut = mapRef(t.config.outputType);
      if (nIn === t.config.inputType && nOut === t.config.outputType) return n;
      return {
        ...t,
        config: { ...t.config, inputType: nIn as string, outputType: nOut as string },
      };
    }
    case "router": {
      const r = n as RouterNode;
      const nIn = mapRef(r.config.inputType);
      if (nIn === r.config.inputType) return n;
      return { ...r, config: { ...r.config, inputType: nIn as string | undefined } };
    }
    case "humanInput": {
      const h = n as HumanInputNode;
      const nPay = mapRef(h.config.payloadRef);
      const nResp = mapRef(h.config.responseSchemaRef);
      if (
        nPay === h.config.payloadRef &&
        nResp === h.config.responseSchemaRef
      )
        return n;
      return {
        ...h,
        config: {
          ...h.config,
          payloadRef: nPay as string | null | undefined,
          responseSchemaRef: nResp as string | null | undefined,
        },
      };
    }
    // join, workflow — no top-level schema refs to update
    default:
      return n;
  }
}

/**
 * Remove a schema from `ir.schemas`. Does NOT scrub references — leaves them
 * dangling so the validator surfaces UNKNOWN_*_SCHEMA_REF / VAR_UNKNOWN_SCHEMA
 * in Preview (honest-surface posture, ADR-0026).
 */
export function deleteSchema(ir: GraphIR, name: string): GraphIR {
  const idx = ir.schemas.findIndex((s) => s.name === name);
  if (idx === -1) return ir;
  return { ...ir, schemas: ir.schemas.filter((s) => s.name !== name) };
}

/** Append a unique `field{N}: str` to the named schema. No-op on unknown schema. */
export function addField(ir: GraphIR, schemaName: string): GraphIR {
  const target = ir.schemas.find((s) => s.name === schemaName);
  if (!target) return ir;
  const taken = new Set(target.fields.map((f) => f.name));
  const fieldName = nextFree("field", taken);
  const fresh: SchemaField = { name: fieldName, type: "str" };
  const schemas = ir.schemas.map((s): SchemaDef =>
    s.name === schemaName ? { ...s, fields: [...s.fields, fresh] } : s,
  );
  return { ...ir, schemas };
}

export interface FieldPatch {
  name?: string;
  // TypeRef = scalar OR a declared schema name (ADR-0037). Runtime logic
  // unchanged from the ScalarType era — assignment is plain copy.
  type?: TypeRef;
  optional?: boolean;
}

/**
 * Patch a single field in a named schema. No-op (returns input IR ref) on
 * unknown schema or unknown field. Field-name renames do NOT cascade into
 * var-chip `field` refs — the validator surfaces VAR_FIELD_NOT_FOUND honestly
 * if a chip points at a renamed/removed field (rare; mirrors deleteSchema
 * posture).
 */
export function updateField(
  ir: GraphIR,
  schemaName: string,
  fieldName: string,
  patch: FieldPatch,
): GraphIR {
  const targetSchema = ir.schemas.find((s) => s.name === schemaName);
  if (!targetSchema) return ir;
  const targetField = targetSchema.fields.find((f) => f.name === fieldName);
  if (!targetField) return ir;

  const schemas = ir.schemas.map((s): SchemaDef => {
    if (s.name !== schemaName) return s;
    const fields = s.fields.map((f): SchemaField => {
      if (f.name !== fieldName) return f;
      const next: SchemaField = { ...f };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.type !== undefined) next.type = patch.type;
      if (patch.optional !== undefined) {
        if (patch.optional) next.optional = true;
        else delete next.optional;
      }
      return next;
    });
    return { ...s, fields };
  });
  return { ...ir, schemas };
}

/** Remove a field from a schema. No-op on unknown schema or unknown field. */
export function deleteField(
  ir: GraphIR,
  schemaName: string,
  fieldName: string,
): GraphIR {
  const targetSchema = ir.schemas.find((s) => s.name === schemaName);
  if (!targetSchema) return ir;
  if (!targetSchema.fields.some((f) => f.name === fieldName)) return ir;
  const schemas = ir.schemas.map((s): SchemaDef =>
    s.name === schemaName
      ? { ...s, fields: s.fields.filter((f) => f.name !== fieldName) }
      : s,
  );
  return { ...ir, schemas };
}
