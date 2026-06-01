/**
 * Pure IR-mutation reducers for canvas topology editing (ADR-0026).
 *
 * The third pure-reducer module alongside `irReducer.ts` and `addNode.ts`.
 * React-free, zustand-free, DOM-free, so the headless test under
 * `node --test` exercises the contracts without `npm install`
 * (ADR-0011 / ADR-0013, reaffirms ADR-0022).
 *
 * Scope: plain edges only — router `route`-labelled edges are a focused
 * follow-up slice. A wire out of a router this slice produces a plain edge
 * and the existing Preview surfaces the validator's
 * `ROUTER_UNLABELED_EDGE` finding (correct, honest behavior; not
 * special-cased).
 *
 * Guard rules are no-ops that return the **same IR reference** so callers
 * (the React store wrapper) can short-circuit without re-rendering. The
 * reducers deliberately do NOT re-implement validation — the validator
 * owns the IR spec (ADR-0001 / ADR-0013); cycles, reachability, etc. flow
 * through Preview's findings list.
 */
import type { GraphIR } from "@graphical-agents/ir";

const START = "START";

/**
 * Append a plain `{ from, to }` edge. `fromId` may be the literal `"START"`.
 * Silent no-op (returns the input IR) when:
 *  - `toId === "START"` (IR invariant 2: START never appears as an edge `to`)
 *  - `fromId === toId` (self-loop — meaningless edit; the DAG check would
 *    catch it anyway)
 *  - an exact duplicate already exists (same `from`, same `to`, and any
 *    `route` matches; this slice only creates plain unlabeled edges so
 *    "duplicate of a plain edge" is the practical case)
 */
export function connectEdge(
  ir: GraphIR,
  fromId: string,
  toId: string,
): GraphIR {
  if (toId === START) return ir;
  if (fromId === toId) return ir;
  for (const e of ir.edges) {
    if (e.from === fromId && e.to === toId && e.route === undefined) return ir;
  }
  return { ...ir, edges: [...ir.edges, { from: fromId, to: toId }] };
}

/**
 * Remove `nodeId` from the top-level graph and every edge that references
 * it (as `from` or `to`). No-op (same IR reference) if `nodeId` is not a
 * top-level node — nested-graph editing is a later slice.
 */
export function deleteNode(ir: GraphIR, nodeId: string): GraphIR {
  if (!ir.nodes.some((n) => n.id === nodeId)) return ir;
  return {
    ...ir,
    nodes: ir.nodes.filter((n) => n.id !== nodeId),
    edges: ir.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

/**
 * Remove every edge matching `{from, to}` (route-agnostic — a click on a
 * router branch edge deletes that edge regardless of its label). No-op
 * (same IR reference) if no edge matches.
 */
export function deleteEdge(
  ir: GraphIR,
  fromId: string,
  toId: string,
): GraphIR {
  if (!ir.edges.some((e) => e.from === fromId && e.to === toId)) return ir;
  return {
    ...ir,
    edges: ir.edges.filter((e) => !(e.from === fromId && e.to === toId)),
  };
}
