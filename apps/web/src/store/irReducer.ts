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

/** Deep-clone via JSON so the store starts from a mutable copy of the fixture. */
export function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
