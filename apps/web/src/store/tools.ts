/**
 * Pure reducers for CRUD over the root tool library `ir.tools` (ADR-0059).
 *
 * Sibling of `schemas.ts` (ADR-0035): React-free, zustand-free, IR types
 * consumed type-only, so headless `node --test` exercises them without an
 * install. Unlike schemas, the library is **root-only** — refs at every
 * nesting depth resolve against it — so the store applies these to the root
 * IR, never through `updateGraphAtPath`, and the rename / delete cascades walk
 * every nesting level.
 *
 * The UI never re-implements validator rules (identifier validity, name
 * clashes, unknown types): Preview surfaces those findings honestly.
 */
import type {
  AgentNode,
  GraphIR,
  GraphNode,
  LoopNode,
  LoopSubAgent,
  SchemaDef,
  ToolDef,
  ToolParam,
  TypeRef,
} from "@graphical-agents/ir";
import { scalarTypes } from "./schemas.ts";

/** The three loop roles that can carry a `tools` list. */
export const LOOP_ROLES = ["generator", "critic", "reviser"] as const;
export type LoopRole = (typeof LOOP_ROLES)[number];

/** Read the library, tolerating IR that predates ADR-0059 (no `tools` key). */
export function toolLibrary(ir: GraphIR): readonly ToolDef[] {
  return ir.tools ?? [];
}

/**
 * Options for a tool param / return-type `<select>`: every scalar (tools take
 * all of them, unlike node I/O slots) followed by the root schemas — the
 * validator resolves tool types against the root graph only.
 */
export function toolTypeCandidates(rootSchemas: readonly SchemaDef[]): readonly TypeRef[] {
  return [...scalarTypes(), ...rootSchemas.map((s) => s.name)];
}

function nextFree(prefix: string, taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Names a fresh tool must avoid: other tools, plus every node name (flat namespace). */
function takenNames(ir: GraphIR): Set<string> {
  const taken = new Set(toolLibrary(ir).map((t) => t.name));
  const visit = (g: GraphIR): void => {
    for (const n of g.nodes) {
      taken.add(n.name);
      if (n.type === "workflow") visit(n.config.graph);
    }
  };
  visit(ir);
  return taken;
}

function withTools(ir: GraphIR, tools: ToolDef[]): GraphIR {
  if (tools.length > 0) return { ...ir, tools };
  // An emptied library serializes to absent, matching pre-ADR-0059 IR.
  const { tools: _drop, ...rest } = ir;
  return rest;
}

/**
 * Append a starter tool: one `text: str` param, `str` return, a placeholder
 * description (the validator requires one — it is what the LLM reads), and a
 * null body (codegen emits a `NotImplementedError` stub).
 */
export function addTool(ir: GraphIR): { ir: GraphIR; toolName: string } {
  const toolName = nextFree("tool", takenNames(ir));
  const fresh: ToolDef = {
    name: toolName,
    description: "Describe what this tool does and when an agent should call it.",
    params: [{ name: "text", type: "str" }],
    returns: "str",
    body: null,
  };
  return { ir: withTools(ir, [...toolLibrary(ir), fresh]), toolName };
}

export interface ToolPatch {
  description?: string;
  returns?: TypeRef;
  /** `null` clears the body (stub). */
  body?: string | null;
}

/** Patch one tool's description / return type / body. No-op on unknown tool. */
export function updateTool(ir: GraphIR, name: string, patch: ToolPatch): GraphIR {
  const lib = toolLibrary(ir);
  if (!lib.some((t) => t.name === name)) return ir;
  return withTools(
    ir,
    lib.map((t): ToolDef => (t.name === name ? { ...t, ...patch } : t)),
  );
}

/**
 * Map every `tools[]` list — agent configs and each loop role — across every
 * nesting level. `fn` returns the next list (or the same reference for no
 * change); an emptied list is dropped so it serializes to absent. Untouched
 * graphs and nodes keep referential identity.
 */
function mapToolRefs(
  g: GraphIR,
  fn: (refs: readonly string[]) => readonly string[],
): GraphIR {
  const nextList = (refs: string[] | undefined): string[] | undefined | null => {
    if (!Array.isArray(refs)) return null; // null = unchanged
    const next = fn(refs);
    if (next === refs) return null;
    return next.length > 0 ? [...next] : undefined;
  };

  let changed = false;
  const nodes = g.nodes.map((n): GraphNode => {
    if (n.type === "agent") {
      const next = nextList(n.config.tools);
      if (next === null) return n;
      changed = true;
      const { tools: _drop, ...rest } = n.config;
      return { ...n, config: next ? { ...rest, tools: next } : rest } as AgentNode;
    }
    if (n.type === "loop") {
      let loopChanged = false;
      const cfg = { ...n.config };
      for (const role of LOOP_ROLES) {
        const sub = n.config[role];
        const next = nextList(sub?.tools);
        if (next === null) continue;
        loopChanged = true;
        const { tools: _drop, ...rest } = sub;
        cfg[role] = (next ? { ...rest, tools: next } : rest) as LoopSubAgent;
      }
      if (!loopChanged) return n;
      changed = true;
      return { ...n, config: cfg } as LoopNode;
    }
    if (n.type === "workflow") {
      const sub = mapToolRefs(n.config.graph, fn);
      if (sub === n.config.graph) return n;
      changed = true;
      return { ...n, config: { ...n.config, graph: sub } };
    }
    return n;
  });
  return changed ? { ...g, nodes } : g;
}

/**
 * Rename a tool AND cascade every reference to it — agent `tools[]` and each
 * loop role's `tools[]`, at every nesting level (refs resolve against the
 * root library from any depth). No-op when unchanged or unknown.
 */
export function renameTool(ir: GraphIR, oldName: string, newName: string): GraphIR {
  if (newName === oldName) return ir;
  const lib = toolLibrary(ir);
  if (!lib.some((t) => t.name === oldName)) return ir;
  const renamed = withTools(
    ir,
    lib.map((t): ToolDef => (t.name === oldName ? { ...t, name: newName } : t)),
  );
  return mapToolRefs(renamed, (refs) =>
    refs.includes(oldName) ? refs.map((r) => (r === oldName ? newName : r)) : refs,
  );
}

/**
 * Remove a tool and scrub its name from every `tools[]` list. Unlike
 * `deleteSchema` (which leaves refs dangling for the validator), a tool ref is
 * one entry in an optional list: removing it is lossless and leaves the agent
 * valid, where a dangling entry would only be a finding to clean up by hand.
 */
export function deleteTool(ir: GraphIR, name: string): GraphIR {
  const lib = toolLibrary(ir);
  if (!lib.some((t) => t.name === name)) return ir;
  const pruned = withTools(ir, lib.filter((t) => t.name !== name));
  return mapToolRefs(pruned, (refs) =>
    refs.includes(name) ? refs.filter((r) => r !== name) : refs,
  );
}

function patchParams(
  ir: GraphIR,
  toolName: string,
  fn: (params: ToolParam[]) => ToolParam[] | null,
): GraphIR {
  const lib = toolLibrary(ir);
  const target = lib.find((t) => t.name === toolName);
  if (!target) return ir;
  const params = fn(target.params);
  if (params === null) return ir;
  return withTools(
    ir,
    lib.map((t): ToolDef => (t.name === toolName ? { ...t, params } : t)),
  );
}

/** Append a unique `arg{N}: str` param. No-op on unknown tool. */
export function addToolParam(ir: GraphIR, toolName: string): GraphIR {
  return patchParams(ir, toolName, (params) => {
    const name = nextFree("arg", new Set(params.map((p) => p.name)));
    return [...params, { name, type: "str" }];
  });
}

/**
 * Patch one param's name / type. A param rename does not touch the body —
 * same posture as a schema field rename vs. var chips (ADR-0035).
 */
export function updateToolParam(
  ir: GraphIR,
  toolName: string,
  paramName: string,
  patch: Partial<ToolParam>,
): GraphIR {
  return patchParams(ir, toolName, (params) => {
    if (!params.some((p) => p.name === paramName)) return null;
    return params.map((p): ToolParam => (p.name === paramName ? { ...p, ...patch } : p));
  });
}

/** Remove one param. No-op on unknown tool / param. */
export function deleteToolParam(ir: GraphIR, toolName: string, paramName: string): GraphIR {
  return patchParams(ir, toolName, (params) => {
    if (!params.some((p) => p.name === paramName)) return null;
    return params.filter((p) => p.name !== paramName);
  });
}

/**
 * Toggle `toolName` in a `tools[]` list for the picker, keeping library order
 * so the generated `tools=[...]` is stable regardless of click order. Entries
 * not in the library (hand-edited IR) are kept, after the library ones, so
 * the validator can still flag them. Returns `undefined` for an empty list.
 */
export function toggleToolRef(
  refs: readonly string[] | undefined,
  toolName: string,
  library: readonly ToolDef[],
): string[] | undefined {
  const current = new Set(refs ?? []);
  if (current.has(toolName)) current.delete(toolName);
  else current.add(toolName);
  const libNames = library.map((t) => t.name);
  const ordered = [
    ...libNames.filter((n) => current.has(n)),
    ...[...current].filter((n) => !libNames.includes(n)),
  ];
  return ordered.length > 0 ? ordered : undefined;
}

/** The `def` header codegen writes for a tool's public function (shown above its body). */
export function toolSignature(tool: ToolDef): string {
  const params = tool.params.map((p) => `${p.name}: ${p.type}`).join(", ");
  return `def _${tool.name}_impl(${params}) -> ${tool.returns}:`;
}
