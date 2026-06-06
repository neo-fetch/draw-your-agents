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
 * Rename a top-level node AND cascade every top-level reference to the old
 * name. Node analog of `renameSchema` (ADR-0035): without the cascade a single
 * rename click would silently break codegen — the var-chip source binding
 * `<Schema.field from name>` (IR-SCHEMA invariant 1) and an agent's
 * `config.tools[]` both address other nodes by `name`.
 *
 * Cascade scope:
 *   - var-segment `source` in every agent's `instruction.segments`
 *   - every entry of every agent's `config.tools[]`
 *
 * Edges are NOT touched: `Edge.from` / `Edge.to` carry node `id`s, not names.
 *
 * No-op (returns the input IR ref) when `nodeId` doesn't name a top-level node
 * or `newName === oldName`. Identifier validity / uniqueness is NOT
 * re-implemented here — invariant 1 lives in `validate.ts` and Preview
 * surfaces `INVALID_NODE_NAME` / `DUPLICATE_NODE_NAME` honestly
 * (ADR-0023 mirror-the-validator posture).
 *
 * Top-level only: nested `workflow.config.graph.nodes` are out of scope,
 * consistent with the nested-graph editing deferral across
 * ADR-0017 / ADR-0023 / ADR-0026 / ADR-0029 / ADR-0035. When sub-graph editing
 * lands, the cascade will need to recurse (or the sub-graph slice picks it up
 * as a sibling concern).
 *
 * Pure: new IR, original untouched, unaffected sibling nodes preserve
 * referential identity so React Flow doesn't re-render unrelated cards.
 */
export function renameNode(
  ir: GraphIR,
  nodeId: string,
  newName: string,
): GraphIR {
  const target = ir.nodes.find((n) => n.id === nodeId);
  if (!target) return ir;
  const oldName = target.name;
  if (newName === oldName) return ir;

  const nodes = ir.nodes.map((n): GraphNode => {
    if (n.id === nodeId) {
      return { ...n, name: newName } as GraphNode;
    }
    if (n.type !== "agent") return n;
    return cascadeAgent(n as AgentNode, oldName, newName);
  });

  return { ...ir, nodes };
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
