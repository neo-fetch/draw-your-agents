/**
 * Pure reducer helpers for the IR store (ADR-0022). Lifted out of `irStore.ts`
 * so the headless test (`test/irStore.test.ts`) can exercise them under
 * `node --test` without depending on `zustand` — i.e. without `npm install`
 * (mirrors the cold-checkout posture of the `packages/*` test suites,
 * ADR-0011 / ADR-0013).
 *
 * `GraphIR` is consumed type-only and erases at runtime.
 */
import type {
  AgentNode,
  GraphIR,
  GraphNode,
  InstructionSegment,
} from "@graphical-agents/ir";
import { graphAtPath, updateGraphAtPath } from "./subgraph.ts";

/** Shallow-merge `patch` into the named node's `config`, returning a new IR. */
export function applyNodeConfigPatch(
  ir: GraphIR,
  nodeId: string,
  patch: Record<string, unknown>,
): GraphIR {
  const nodes = ir.nodes.map((n): GraphNode => {
    if (n.id !== nodeId) return n;
    return { ...n, config: { ...n.config, ...patch } } as GraphNode;
  });
  return { ...ir, nodes };
}

export type ModelParamKey =
  | "temperature"
  | "topP"
  | "topK"
  | "maxOutputTokens";

/**
 * Patch one key inside an agent node's nested `modelParams` without clobbering
 * the others (the shallow `applyNodeConfigPatch` would). `value === undefined`
 * clears the key; if `modelParams` becomes empty, the field is removed
 * entirely so it serializes to absent, not `{}`.
 */
export function applyModelParamPatch(
  ir: GraphIR,
  nodeId: string,
  key: ModelParamKey,
  value: number | undefined,
): GraphIR {
  const nodes = ir.nodes.map((n): GraphNode => {
    if (n.id !== nodeId || n.type !== "agent") return n;
    const prev = n.config.modelParams ?? {};
    const nextParams: Record<string, number> = { ...prev };
    if (value === undefined) delete nextParams[key];
    else nextParams[key] = value;
    const cleaned = Object.keys(nextParams).length === 0 ? undefined : nextParams;
    const { modelParams: _drop, ...rest } = n.config;
    const nextConfig =
      cleaned === undefined ? rest : { ...rest, modelParams: cleaned };
    return { ...n, config: nextConfig } as GraphNode;
  });
  return { ...ir, nodes };
}

/**
 * Set a node's canvas position (writes `node.ui.{x,y}`). Used by the canvas
 * drag handler to persist positions into the IR (ADR-0028). No-op (returns
 * the input IR reference) when the node id isn't found or the position is
 * unchanged — so React Flow's position events during idle re-renders don't
 * trigger spurious store updates.
 */
export function applyNodePosition(
  ir: GraphIR,
  nodeId: string,
  x: number,
  y: number,
): GraphIR {
  let changed = false;
  const nodes = ir.nodes.map((n): GraphNode => {
    if (n.id !== nodeId) return n;
    if (n.ui && n.ui.x === x && n.ui.y === y) return n;
    changed = true;
    return { ...n, ui: { x, y } } as GraphNode;
  });
  if (!changed) return ir;
  return { ...ir, nodes };
}

/**
 * Rename the node `nodeId` in the graph at `path` AND cascade every
 * reference to the old name across **all** nesting levels (ADR-0050). Node
 * analog of `renameSchema` (ADR-0035): without the cascade a single rename
 * click would silently break codegen — the var-chip source binding
 * `<Schema.field from name>` (IR-SCHEMA invariant 1) and an agent's
 * `config.tools[]` both address other nodes by `name`.
 *
 * Cascade scope:
 *   - var-segment `source` in every agent's `instruction.segments`
 *   - every entry of every agent's `config.tools[]`
 *
 * The cascade recurses through every `workflow.config.graph`. Var sources
 * only resolve per-level in the validator, but `tools[]` entries resolve
 * globally by name; node names are globally unique (ADR-0017), so a
 * tree-wide cascade is correct for both and needs no scoping logic.
 *
 * The rename itself is path-scoped (never "find this id anywhere"): node ids
 * are only conventionally global, so a hand-loaded IR may reuse an id across
 * levels.
 *
 * Edges are NOT touched: `Edge.from` / `Edge.to` carry node `id`s, not names.
 *
 * No-op (returns the input IR ref) when `path` doesn't resolve, `nodeId`
 * isn't in that graph, or `newName === oldName`. Identifier validity /
 * uniqueness is NOT re-implemented here — invariant 1 lives in `validate.ts`
 * and Preview surfaces `INVALID_NODE_NAME` / `DUPLICATE_NODE_NAME` honestly
 * (ADR-0023 mirror-the-validator posture).
 *
 * Pure: new IR, original untouched, unaffected sibling nodes preserve
 * referential identity so React Flow doesn't re-render unrelated cards.
 */
export function renameNodeAt(
  ir: GraphIR,
  path: readonly string[],
  nodeId: string,
  newName: string,
): GraphIR {
  const graph = graphAtPath(ir, path);
  if (!graph) return ir;
  const target = graph.nodes.find((n) => n.id === nodeId);
  if (!target) return ir;
  const oldName = target.name;
  if (newName === oldName) return ir;

  // Pass 1: rename the target node, path-scoped.
  const renamed = updateGraphAtPath(ir, path, (g) => ({
    ...g,
    nodes: g.nodes.map((n): GraphNode =>
      n.id === nodeId ? ({ ...n, name: newName } as GraphNode) : n,
    ),
  }));

  // Pass 2: cascade references across every level. The renamed node itself
  // no longer carries `oldName`, so the cascade can't touch it.
  return cascadeGraph(renamed, oldName, newName);
}

/** Back-compat top-level entry point: `renameNodeAt` with the root path. */
export function renameNode(
  ir: GraphIR,
  nodeId: string,
  newName: string,
): GraphIR {
  return renameNodeAt(ir, [], nodeId, newName);
}

/**
 * Apply `cascadeAgent` to every agent at every nesting level. Same-reference
 * no-op discipline throughout so untouched graphs and nodes keep referential
 * identity.
 */
function cascadeGraph(g: GraphIR, oldName: string, newName: string): GraphIR {
  let changed = false;
  const nodes = g.nodes.map((n): GraphNode => {
    if (n.type === "agent") {
      const next = cascadeAgent(n as AgentNode, oldName, newName);
      if (next !== n) changed = true;
      return next;
    }
    if (n.type === "workflow") {
      const nextSub = cascadeGraph(n.config.graph, oldName, newName);
      if (nextSub !== n.config.graph) {
        changed = true;
        return { ...n, config: { ...n.config, graph: nextSub } };
      }
      return n;
    }
    return n;
  });
  return changed ? { ...g, nodes } : g;
}

function cascadeAgent(
  a: AgentNode,
  oldName: string,
  newName: string,
): AgentNode {
  const inSeg = a.config.instruction.segments;
  let segmentsChanged = false;
  const nextSegments: InstructionSegment[] = inSeg.map((seg) => {
    if (seg.type === "var" && seg.source === oldName) {
      segmentsChanged = true;
      return { ...seg, source: newName };
    }
    return seg;
  });

  const prevTools = a.config.tools;
  let toolsChanged = false;
  let nextTools: string[] | undefined = prevTools;
  if (Array.isArray(prevTools)) {
    const mapped = prevTools.map((t) => {
      if (t === oldName) {
        toolsChanged = true;
        return newName;
      }
      return t;
    });
    if (toolsChanged) nextTools = mapped;
  }

  if (!segmentsChanged && !toolsChanged) return a;

  return {
    ...a,
    config: {
      ...a.config,
      instruction: segmentsChanged
        ? { segments: nextSegments }
        : a.config.instruction,
      tools: toolsChanged ? nextTools : a.config.tools,
    },
  };
}

/** Deep-clone via JSON so the store starts from a mutable copy of the fixture. */
export function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
