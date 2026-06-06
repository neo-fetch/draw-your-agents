/**
 * Graph IR validator — the authoritative IR spec (ADR-0001, ADR-0013).
 *
 * Ports every invariant from docs/IR-SCHEMA.md §Invariants (and the Phase-0
 * stand-in `scripts/check_ir.py`, now superseded) into a typed `validate(ir)`
 * that returns **structured findings** rather than thrown strings, so callers
 * (codegen's `compile`, the `check:ir` gate, the future visual builder) can
 * present, filter, and locate problems.
 *
 * `severity: "warning"` is reserved for the join-failsafe and
 * incompatible-integration rules (ARCHITECTURE.md §7); those constructs arrive
 * in Phase 3, so the warning pass is stubbed and emits nothing yet.
 */
import type { GraphIR } from "./types.js";

export type Severity = "error" | "warning";

/** A single validation result. `nodeId` locates node-/edge-/var-scoped findings. */
export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  nodeId?: string;
}

export interface ValidationResult {
  /** True when there are no error-severity findings. */
  ok: boolean;
  /** All findings, in discovery order. */
  findings: Finding[];
  /** Findings with `severity === "error"` (these block codegen). */
  errors: Finding[];
  /** Findings with `severity === "warning"` (advisory). */
  warnings: Finding[];
}

/** Stable finding codes. Tests and UIs key off these, not the messages. */
export const ValidationCode = {
  // Structural
  MISSING_TOP_LEVEL_KEY: "MISSING_TOP_LEVEL_KEY",
  INVALID_WORKFLOW_NAME: "INVALID_WORKFLOW_NAME",
  // Schemas
  INVALID_SCHEMA_NAME: "INVALID_SCHEMA_NAME",
  DUPLICATE_SCHEMA_NAME: "DUPLICATE_SCHEMA_NAME",
  INVALID_FIELD_NAME: "INVALID_FIELD_NAME",
  UNKNOWN_FIELD_TYPE: "UNKNOWN_FIELD_TYPE",
  SCHEMA_FIELD_CYCLE: "SCHEMA_FIELD_CYCLE",
  // Nodes
  NODE_MISSING_ID: "NODE_MISSING_ID",
  DUPLICATE_NODE_ID: "DUPLICATE_NODE_ID",
  UNKNOWN_NODE_TYPE: "UNKNOWN_NODE_TYPE",
  INVALID_NODE_NAME: "INVALID_NODE_NAME",
  DUPLICATE_NODE_NAME: "DUPLICATE_NODE_NAME",
  START_RESERVED: "START_RESERVED",
  // Per-type config
  AGENT_MISSING_MODEL: "AGENT_MISSING_MODEL",
  UNKNOWN_OUTPUT_SCHEMA_REF: "UNKNOWN_OUTPUT_SCHEMA_REF",
  UNKNOWN_INPUT_SCHEMA_REF: "UNKNOWN_INPUT_SCHEMA_REF",
  FUNCTION_UNKNOWN_INPUT_TYPE: "FUNCTION_UNKNOWN_INPUT_TYPE",
  FUNCTION_UNKNOWN_OUTPUT_TYPE: "FUNCTION_UNKNOWN_OUTPUT_TYPE",
  TOOL_UNKNOWN_INPUT_TYPE: "TOOL_UNKNOWN_INPUT_TYPE",
  TOOL_UNKNOWN_OUTPUT_TYPE: "TOOL_UNKNOWN_OUTPUT_TYPE",
  ROUTER_NO_ROUTES: "ROUTER_NO_ROUTES",
  HUMANINPUT_MISSING_MESSAGE: "HUMANINPUT_MISSING_MESSAGE",
  UNKNOWN_HUMANINPUT_PAYLOAD_REF: "UNKNOWN_HUMANINPUT_PAYLOAD_REF",
  UNKNOWN_HUMANINPUT_RESPONSE_SCHEMA_REF: "UNKNOWN_HUMANINPUT_RESPONSE_SCHEMA_REF",
  WORKFLOW_MISSING_GRAPH: "WORKFLOW_MISSING_GRAPH",
  // Prompt-variable provenance (IR-SCHEMA invariant 6)
  VAR_SOURCE_NOT_NODE: "VAR_SOURCE_NOT_NODE",
  VAR_SOURCE_NOT_STRUCTURED: "VAR_SOURCE_NOT_STRUCTURED",
  VAR_SCHEMA_MISMATCH_SOURCE: "VAR_SCHEMA_MISMATCH_SOURCE",
  VAR_UNKNOWN_SCHEMA: "VAR_UNKNOWN_SCHEMA",
  VAR_FIELD_NOT_FOUND: "VAR_FIELD_NOT_FOUND",
  VAR_INPUT_SCHEMA_MISMATCH: "VAR_INPUT_SCHEMA_MISMATCH",
  // Edges
  EDGE_FROM_UNKNOWN: "EDGE_FROM_UNKNOWN",
  EDGE_TO_START: "EDGE_TO_START",
  EDGE_TO_UNKNOWN: "EDGE_TO_UNKNOWN",
  NO_START_EDGE: "NO_START_EDGE",
  ROUTER_UNLABELED_EDGE: "ROUTER_UNLABELED_EDGE",
  ROUTER_ROUTE_NO_TARGET: "ROUTER_ROUTE_NO_TARGET",
  ROUTER_EDGE_ROUTE_UNDECLARED: "ROUTER_EDGE_ROUTE_UNDECLARED",
  NONROUTER_ROUTE_LABEL: "NONROUTER_ROUTE_LABEL",
  // Graph shape
  UNREACHABLE_NODE: "UNREACHABLE_NODE",
  CYCLE_DETECTED: "CYCLE_DETECTED",
  // Reserved warnings (ARCHITECTURE.md §7) — stubbed until Phase 3.
  JOIN_MISSING_FAILSAFE: "JOIN_MISSING_FAILSAFE",
  INCOMPATIBLE_INTEGRATION: "INCOMPATIBLE_INTEGRATION",
} as const;

export type ValidationCodeName = keyof typeof ValidationCode;

const START = "START";
const SCALARS = new Set(["str", "int", "float", "bool", "date", "datetime"]);
const NODE_TYPES = new Set([
  "agent",
  "function",
  "router",
  "tool",
  "join",
  "humanInput",
  "workflow",
]);
// Hard keywords only — mirrors Python's `keyword.iskeyword` (soft keywords like
// `match`/`case`/`type` are not reserved and remain valid identifiers).
const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally", "for",
  "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
  "pass", "raise", "return", "try", "while", "with", "yield",
]);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Valid, non-keyword Python identifier (ports `check_ir.is_ident`). */
function isIdent(s: unknown): s is string {
  return typeof s === "string" && IDENT_RE.test(s) && !PY_KEYWORDS.has(s);
}

function repr(v: unknown): string {
  return v === undefined ? "None" : JSON.stringify(v);
}

// The validator must tolerate malformed input (hand-edited IR, draw.io import),
// so it reads through a permissive view rather than trusting the static types.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = Record<string, any>;

/**
 * Recursion context threaded through validateGraph (ADR-0017).
 *  - `pathPrefix`  composes finding `nodeId`s as `<parentId>/.../<nodeId>` so
 *                  callers can locate a finding to its enclosing workflow node.
 *  - `globalNames` / `globalSchemas` enforce a **single, flat namespace** for
 *                  node names and schema names across parent + every nested
 *                  sub-graph (invariant 1 holds across nesting).
 */
interface RecursionCtx {
  readonly pathPrefix: string;
  readonly globalNames: Set<string>;
  readonly globalSchemas: Set<string>;
  readonly findings: Finding[];
}

/** Validate an IR document, returning structured findings (never throws). */
export function validate(ir: GraphIR): ValidationResult {
  const findings: Finding[] = [];
  validateGraph(ir, {
    pathPrefix: "",
    globalNames: new Set(),
    globalSchemas: new Set(),
    findings,
  });
  return result(findings);
}

function validateGraph(ir: GraphIR, ctx: RecursionCtx): void {
  const { pathPrefix, globalNames, globalSchemas, findings } = ctx;
  const findingsAtEntry = findings.length;
  const composeId = (nid: string): string => `${pathPrefix}${nid}`;
  const err = (code: string, message: string, nodeId?: string): void => {
    findings.push(
      nodeId === undefined
        ? { severity: "error", code, message }
        : { severity: "error", code, message, nodeId: composeId(nodeId) },
    );
  };

  const doc = ir as unknown as Loose;

  // 1. Required top-level keys — short-circuit like the Python stand-in does, so
  //    later passes can assume the shape is roughly present.
  for (const key of ["irVersion", "name", "nodes", "edges", "schemas"]) {
    if (!(key in doc) || doc[key] === undefined) {
      err(ValidationCode.MISSING_TOP_LEVEL_KEY, `missing top-level key '${key}'`);
    }
  }
  // Short-circuit only on findings *added in this call* — a nested call must not
  // be aborted by findings the parent already accumulated.
  if (findings.length > findingsAtEntry) return;

  if (!isIdent(doc.name)) {
    err(ValidationCode.INVALID_WORKFLOW_NAME, `workflow name is not a valid python identifier: ${repr(doc.name)}`);
  }

  const schemaList: Loose[] = Array.isArray(doc.schemas) ? doc.schemas : [];
  const nodeList: Loose[] = Array.isArray(doc.nodes) ? doc.nodes : [];
  const edgeList: Loose[] = Array.isArray(doc.edges) ? doc.edges : [];

  // -- index schemas --
  // Pre-collect declared schema names so the field-type check below sees forward
  // references (a field on schema A may legitimately type to schema B that's
  // declared later in the array, as long as the dependency DAG is acyclic).
  const declaredSchemaNames = new Set<string>();
  for (const s of schemaList) {
    if (typeof s?.name === "string") declaredSchemaNames.add(s.name);
  }
  const fieldTypeOk = (t: unknown): boolean =>
    typeof t === "string" && (SCALARS.has(t) || declaredSchemaNames.has(t));

  const schemaFields = new Map<string, Set<string>>(); // schema name -> field names
  // schema name -> the names of other declared schemas its fields reference.
  // Used to detect SCHEMA_FIELD_CYCLE (self-ref or A↔B). Scoped to this level
  // (same as refOk) — flat-global names live in globalSchemas separately.
  const schemaDeps = new Map<string, string[]>();
  for (const s of schemaList) {
    const name = s?.name;
    if (!isIdent(name)) {
      err(ValidationCode.INVALID_SCHEMA_NAME, `schema name is not a valid identifier: ${repr(name)}`);
    }
    if (typeof name === "string") {
      // Flat global namespace across parent + every nested sub-graph (ADR-0017).
      if (globalSchemas.has(name) || schemaFields.has(name)) {
        err(ValidationCode.DUPLICATE_SCHEMA_NAME, `duplicate schema name ${repr(name)}`);
      } else {
        globalSchemas.add(name);
      }
    }
    const fields: Loose[] = Array.isArray(s?.fields) ? s.fields : [];
    const fieldSet = new Set<string>();
    const deps: string[] = [];
    for (const f of fields) {
      const fname = f?.name;
      if (!isIdent(fname)) {
        err(ValidationCode.INVALID_FIELD_NAME, `schema ${name}: bad field name ${repr(fname)}`);
      } else {
        fieldSet.add(fname);
      }
      if (!fieldTypeOk(f?.type)) {
        err(ValidationCode.UNKNOWN_FIELD_TYPE, `schema ${name}.${fname}: bad type ${repr(f?.type)}`);
      } else if (declaredSchemaNames.has(f.type)) {
        deps.push(f.type);
      }
    }
    if (typeof name === "string") {
      schemaFields.set(name, fieldSet);
      schemaDeps.set(name, deps);
    }
  }

  // Schema-to-schema field-reference DAG (per validateGraph level). v1 rejects
  // any cycle (including self-reference): without forward-ref + model_rebuild
  // codegen, declared-before-used emission would otherwise be unsatisfiable.
  // Mirrors the edge-cycle DFS below — same WHITE/GREY/BLACK colouring.
  {
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const n of schemaDeps.keys()) color.set(n, WHITE);
    const dfs = (u: string): void => {
      color.set(u, GREY);
      for (const v of schemaDeps.get(u) ?? []) {
        if (!color.has(v)) continue;
        if (color.get(v) === GREY) {
          err(
            ValidationCode.SCHEMA_FIELD_CYCLE,
            `schema field-reference cycle through ${v}`,
          );
        } else if (color.get(v) === WHITE) {
          dfs(v);
        }
      }
      color.set(u, BLACK);
    };
    for (const n of schemaDeps.keys()) {
      if (color.get(n) === WHITE) dfs(n);
    }
  }

  const refOk = (ref: unknown, allowNull = false): boolean => {
    if (ref === null || ref === undefined) return allowNull;
    if (ref === "str") return true;
    return typeof ref === "string" && schemaFields.has(ref);
  };

  // -- index nodes --
  const nodesById = new Map<string, Loose>();
  const nameToId = new Map<string, string>();
  for (const n of nodeList) {
    const nid = n?.id;
    const nm = n?.name;
    const t = n?.type;
    if (!nid) {
      err(ValidationCode.NODE_MISSING_ID, "a node is missing 'id'");
      continue;
    }
    if (nodesById.has(nid)) err(ValidationCode.DUPLICATE_NODE_ID, `duplicate node id ${repr(nid)}`, nid);
    nodesById.set(nid, n);
    if (!NODE_TYPES.has(t)) err(ValidationCode.UNKNOWN_NODE_TYPE, `node ${nid}: unknown type ${repr(t)}`, nid);
    if (!isIdent(nm)) {
      err(ValidationCode.INVALID_NODE_NAME, `node ${nid}: name is not a valid python identifier: ${repr(nm)}`, nid);
    } else if (nameToId.has(nm) || globalNames.has(nm)) {
      // Flat global namespace across parent + every nested sub-graph (ADR-0017).
      err(ValidationCode.DUPLICATE_NODE_NAME, `duplicate node name ${repr(nm)} (used as the codegen symbol)`, nid);
    } else {
      nameToId.set(nm, nid);
      globalNames.add(nm);
    }
  }
  if (nameToId.has(START)) {
    err(ValidationCode.START_RESERVED, "'START' is reserved and cannot be a node name");
  }

  // outputType ?? outputSchemaRef, matching `cfg.get("outputType", cfg.get("outputSchemaRef"))`.
  const producerOutput = (node: Loose): unknown => {
    const c = (node?.config ?? {}) as Loose;
    return "outputType" in c ? c.outputType : c.outputSchemaRef;
  };

  // -- per-type checks --
  const checkVarSegment = (ctx: string, agentCfg: Loose, seg: Loose, nodeId: string): void => {
    const sch = seg?.schema;
    const fld = seg?.field;
    const src = seg?.source;
    if (typeof src !== "string" || !nameToId.has(src)) {
      err(ValidationCode.VAR_SOURCE_NOT_NODE, `${ctx}: prompt variable source ${repr(src)} is not a node`, nodeId);
    } else {
      const out = producerOutput(nodesById.get(nameToId.get(src)!)!);
      if (out === "str" || out === null || out === undefined) {
        err(
          ValidationCode.VAR_SOURCE_NOT_STRUCTURED,
          `${ctx}: variable <${sch}.${fld} from ${src}> requires ${src} to output a structured schema, but it outputs ${repr(out)}`,
          nodeId,
        );
      } else if (out !== sch) {
        err(
          ValidationCode.VAR_SCHEMA_MISMATCH_SOURCE,
          `${ctx}: variable schema ${repr(sch)} does not match ${src} output schema ${repr(out)}`,
          nodeId,
        );
      }
    }
    if (typeof sch !== "string" || !schemaFields.has(sch)) {
      err(ValidationCode.VAR_UNKNOWN_SCHEMA, `${ctx}: unknown schema ${repr(sch)}`, nodeId);
    } else if (!schemaFields.get(sch)!.has(fld)) {
      err(ValidationCode.VAR_FIELD_NOT_FOUND, `${ctx}: schema ${sch} has no field ${repr(fld)}`, nodeId);
    }
    if (agentCfg?.inputSchemaRef !== sch) {
      err(
        ValidationCode.VAR_INPUT_SCHEMA_MISMATCH,
        `${ctx}: uses a variable from schema ${sch} but inputSchemaRef is ${repr(agentCfg?.inputSchemaRef)}`,
        nodeId,
      );
    }
  };

  for (const n of nodesById.values()) {
    const c = (n.config ?? {}) as Loose;
    switch (n.type) {
      case "agent": {
        const ctx = `agent ${n.name}`;
        if (!c.model) err(ValidationCode.AGENT_MISSING_MODEL, `${ctx}: missing model`, n.id);
        if (!refOk(c.outputSchemaRef)) {
          err(ValidationCode.UNKNOWN_OUTPUT_SCHEMA_REF, `${ctx}: unknown outputSchemaRef ${repr(c.outputSchemaRef)}`, n.id);
        }
        if (!refOk(c.inputSchemaRef, true)) {
          err(ValidationCode.UNKNOWN_INPUT_SCHEMA_REF, `${ctx}: unknown inputSchemaRef ${repr(c.inputSchemaRef)}`, n.id);
        }
        const segments: Loose[] = Array.isArray(c.instruction?.segments) ? c.instruction.segments : [];
        for (const seg of segments) {
          if (seg?.type === "var") checkVarSegment(ctx, c, seg, n.id);
        }
        break;
      }
      case "function": {
        const ctx = `function ${n.name}`;
        if (!refOk(c.inputType)) {
          err(ValidationCode.FUNCTION_UNKNOWN_INPUT_TYPE, `${ctx}: unknown inputType ${repr(c.inputType)}`, n.id);
        }
        if (!refOk(c.outputType)) {
          err(ValidationCode.FUNCTION_UNKNOWN_OUTPUT_TYPE, `${ctx}: unknown outputType ${repr(c.outputType)}`, n.id);
        }
        break;
      }
      case "tool": {
        const ctx = `tool ${n.name}`;
        if (!refOk(c.inputType)) {
          err(ValidationCode.TOOL_UNKNOWN_INPUT_TYPE, `${ctx}: unknown inputType ${repr(c.inputType)}`, n.id);
        }
        if (!refOk(c.outputType)) {
          err(ValidationCode.TOOL_UNKNOWN_OUTPUT_TYPE, `${ctx}: unknown outputType ${repr(c.outputType)}`, n.id);
        }
        break;
      }
      case "router": {
        if (!(Array.isArray(c.routes) && c.routes.length > 0)) {
          err(ValidationCode.ROUTER_NO_ROUTES, `router ${n.name}: must declare at least one route`, n.id);
        }
        break;
      }
      case "humanInput": {
        const ctx = `humanInput ${n.name}`;
        if (!c.message) err(ValidationCode.HUMANINPUT_MISSING_MESSAGE, `${ctx}: missing message`, n.id);
        if (!refOk(c.payloadRef, true)) {
          err(ValidationCode.UNKNOWN_HUMANINPUT_PAYLOAD_REF, `${ctx}: unknown payloadRef ${repr(c.payloadRef)}`, n.id);
        }
        if (!refOk(c.responseSchemaRef, true)) {
          err(
            ValidationCode.UNKNOWN_HUMANINPUT_RESPONSE_SCHEMA_REF,
            `${ctx}: unknown responseSchemaRef ${repr(c.responseSchemaRef)}`,
            n.id,
          );
        }
        break;
      }
      case "workflow": {
        // A nested workflow is itself a valid graph — recurse with the same
        // rule set, threading the global namespaces and a longer pathPrefix so
        // findings inside the sub-graph are located back to the parent
        // (ADR-0017).
        if (c.graph === null || typeof c.graph !== "object" || Array.isArray(c.graph)) {
          err(
            ValidationCode.WORKFLOW_MISSING_GRAPH,
            `workflow ${n.name}: missing or invalid 'graph' sub-IR`,
            n.id,
          );
        } else {
          validateGraph(c.graph as GraphIR, {
            pathPrefix: `${pathPrefix}${n.id}/`,
            globalNames,
            globalSchemas,
            findings,
          });
        }
        break;
      }
      default:
        break; // join has no per-type checks
    }
  }

  // -- edges --
  for (const e of edgeList) {
    const frm = e?.from;
    const to = e?.to;
    if (frm !== START && !nodesById.has(frm)) {
      err(ValidationCode.EDGE_FROM_UNKNOWN, `edge from unknown node ${repr(frm)}`);
    }
    if (to === START) {
      err(ValidationCode.EDGE_TO_START, "an edge points TO 'START', which is not allowed");
    } else if (!nodesById.has(to)) {
      err(ValidationCode.EDGE_TO_UNKNOWN, `edge to unknown node ${repr(to)}`);
    }
  }
  if (!edgeList.some((e) => e?.from === START)) {
    err(ValidationCode.NO_START_EDGE, "graph has no START edge");
  }

  // router branch consistency: declared routes ⇔ out-edge labels
  for (const [nid, n] of nodesById) {
    if (n.type !== "router") continue;
    const declared = new Set<string>(Array.isArray(n.config?.routes) ? n.config.routes : []);
    const labels = new Set<unknown>();
    for (const e of edgeList) if (e?.from === nid) labels.add(e?.route);
    if (labels.has(undefined) || labels.has(null)) {
      err(ValidationCode.ROUTER_UNLABELED_EDGE, `router ${n.name}: has an outgoing edge without a route label`, nid);
      labels.delete(undefined);
      labels.delete(null);
    }
    const missing = [...declared].filter((r) => !labels.has(r)).sort();
    if (missing.length > 0) {
      err(ValidationCode.ROUTER_ROUTE_NO_TARGET, `router ${n.name}: routes with no target edge: ${repr(missing)}`, nid);
    }
    const extra = [...labels].filter((r) => !declared.has(r as string)).sort();
    if (extra.length > 0) {
      err(ValidationCode.ROUTER_EDGE_ROUTE_UNDECLARED, `router ${n.name}: edge routes not declared: ${repr(extra)}`, nid);
    }
  }

  // non-router out-edges must not carry route labels
  for (const e of edgeList) {
    const frm = e?.from;
    const isRouter = frm !== START && nodesById.get(frm)?.type === "router";
    if (e?.route && !isRouter) {
      err(ValidationCode.NONROUTER_ROUTE_LABEL, `edge ${frm}->${e?.to} has a route label but ${frm} is not a router`);
    }
  }

  // -- graph shape: reachability + DAG --
  const adj = new Map<string, string[]>();
  for (const e of edgeList) {
    const frm = e?.from;
    if (frm === undefined || frm === null) continue;
    const list = adj.get(frm);
    if (list) list.push(e.to);
    else adj.set(frm, [e.to]);
  }

  // reachability from START
  const seen = new Set<string>();
  const stack: string[] = [...(adj.get(START) ?? [])];
  while (stack.length > 0) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const y of adj.get(x) ?? []) stack.push(y);
  }
  for (const [nid, n] of nodesById) {
    if (!seen.has(nid)) {
      err(ValidationCode.UNREACHABLE_NODE, `node ${n.name} (${nid}) is unreachable from START`, nid);
    }
  }

  // cycle detection (DAG required in v1) — white/grey/black colouring
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const nid of nodesById.keys()) color.set(nid, WHITE);
  const dfs = (u: string): void => {
    color.set(u, GREY);
    for (const v of adj.get(u) ?? []) {
      if (!color.has(v)) continue; // skip START and dangling targets
      if (color.get(v) === GREY) {
        err(ValidationCode.CYCLE_DETECTED, `cycle detected through node ${nodesById.get(v)!.name}`, v);
      } else if (color.get(v) === WHITE) {
        dfs(v);
      }
    }
    color.set(u, BLACK);
  };
  for (const nid of nodesById.keys()) {
    if (color.get(nid) === WHITE) dfs(nid);
  }

  // -- warning pass (ARCHITECTURE.md §7) --
  checkJoinFailsafe(findings, nodesById, edgeList, composeId);
}

/**
 * JOIN_MISSING_FAILSAFE — every upstream of a join should produce output on the
 * `output` channel, or ADK's JoinNode may hang. Flagged cases:
 *  - Agent nodes with null/missing outputSchemaRef (may not produce output).
 *  - Function nodes with `emits: "message"` (emit to the user channel, not
 *    the output channel that JoinNode waits on).
 * Function nodes emitting "output" and router nodes are inherently safe.
 */
function checkJoinFailsafe(
  findings: Finding[],
  nodesById: ReadonlyMap<string, Loose>,
  edgeList: readonly Loose[],
  composeId: (nid: string) => string,
): void {
  const warn = (code: string, message: string, nodeId?: string): void => {
    findings.push(
      nodeId === undefined
        ? { severity: "warning", code, message }
        : { severity: "warning", code, message, nodeId: composeId(nodeId) },
    );
  };

  for (const [joinId, joinNode] of nodesById) {
    if (joinNode.type !== "join") continue;
    // Find all upstream nodes feeding this join.
    for (const e of edgeList) {
      if (e?.to !== joinId) continue;
      const fromId = e?.from;
      if (fromId === START || !nodesById.has(fromId)) continue;
      const upstream = nodesById.get(fromId)!;
      const cfg = (upstream.config ?? {}) as Loose;

      let flagged = false;
      if (upstream.type === "agent") {
        if (cfg.outputSchemaRef === null || cfg.outputSchemaRef === undefined) {
          flagged = true;
        }
      } else if (upstream.type === "function") {
        if (cfg.emits === "message") {
          flagged = true;
        }
      }

      if (flagged) {
        warn(
          ValidationCode.JOIN_MISSING_FAILSAFE,
          `node "${upstream.name}" feeds join "${joinNode.name}" but may not produce output on the ` +
            `output channel — JoinNode waits for output from every upstream`,
          fromId,
        );
      }
    }
  }
}

function result(findings: Finding[]): ValidationResult {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return { ok: errors.length === 0, findings, errors, warnings };
}
