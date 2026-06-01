/**
 * Pure reducer helpers for the IR store (ADR-0022). Lifted out of `irStore.ts`
 * so the headless test (`test/irStore.test.ts`) can exercise them under
 * `node --test` without depending on `zustand` — i.e. without `npm install`
 * (mirrors the cold-checkout posture of the `packages/*` test suites,
 * ADR-0011 / ADR-0013).
 *
 * `GraphIR` is consumed type-only and erases at runtime.
 */
import type { GraphIR, GraphNode } from "@graphical-agents/ir";

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

/** Deep-clone via JSON so the store starts from a mutable copy of the fixture. */
export function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
