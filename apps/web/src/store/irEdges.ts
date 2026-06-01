/**
 * Pure IR-mutation reducers for canvas topology editing (ADR-0026, ADR-0027).
 *
 * The third pure-reducer module alongside `irReducer.ts` and `addNode.ts`.
 * React-free, zustand-free, DOM-free, so the headless test under
 * `node --test` exercises the contracts without `npm install`
 * (ADR-0011 / ADR-0013, reaffirms ADR-0022).
 *
 * Router `route` labels on edges are wired here (ADR-0027): `connectEdge`
 * accepts an optional `route` arg and `setEdgeRoute` relabels one specific
 * router edge. The reducers deliberately do NOT re-implement validation —
 * the validator owns the IR spec (ADR-0001 / ADR-0013); cycles, reachability,
 * router-route declared-vs-edge balance, etc. flow through Preview's
 * findings list.
 *
 * Guard rules are no-ops that return the **same IR reference** so callers
 * (the React store wrapper) can short-circuit without re-rendering.
 */
import type { GraphIR } from "@graphical-agents/ir";

const START = "START";

/**
 * Append a `{ from, to, route? }` edge. `fromId` may be the literal `"START"`.
 * Silent no-op (returns the input IR) when:
 *  - `toId === "START"` (IR invariant 2: START never appears as an edge `to`)
 *  - `fromId === toId` (self-loop — meaningless edit; the DAG check would
 *    catch it anyway)
 *  - an exact duplicate already exists — same `from`, same `to`, **and the
 *    same `route`** (both undefined counts as a match). Two edges from the
 *    same router to the same target with *different* routes is allowed —
 *    ADK route maps `{"A": target, "B": target}` are a legitimate shape.
 */
export function connectEdge(
  ir: GraphIR,
  fromId: string,
  toId: string,
  route?: string,
): GraphIR {
  if (toId === START) return ir;
  if (fromId === toId) return ir;
  for (const e of ir.edges) {
    if (e.from === fromId && e.to === toId && e.route === route) return ir;
  }
  const edge: { from: string; to: string; route?: string } = { from: fromId, to: toId };
  if (route !== undefined) edge.route = route;
  return { ...ir, edges: [...ir.edges, edge] };
}

/**
 * Relabel one specific router edge from `oldRoute` to `newRoute`. The
 * `(from, to, oldRoute)` triple identifies the edge precisely — a router
 * may have multiple out-edges to different targets, and (per the
 * `connectEdge` duplicate rule) two routes can even point to the same
 * target. No-op (returns the input IR reference) if no edge matches.
 *
 * `newRoute === undefined` produces an unlabeled edge — the validator
 * surfaces `ROUTER_UNLABELED_EDGE` if the source is a router. The UI never
 * dispatches that case, but the reducer accepts it for symmetry.
 */
export function setEdgeRoute(
  ir: GraphIR,
  fromId: string,
  toId: string,
  oldRoute: string | undefined,
  newRoute: string | undefined,
): GraphIR {
  let foundIndex = -1;
  for (let i = 0; i < ir.edges.length; i++) {
    const e = ir.edges[i]!;
    if (e.from === fromId && e.to === toId && e.route === oldRoute) {
      foundIndex = i;
      break;
    }
  }
  if (foundIndex < 0) return ir;
  const next = ir.edges.slice();
  const replacement: { from: string; to: string; route?: string } = {
    from: fromId,
    to: toId,
  };
  if (newRoute !== undefined) replacement.route = newRoute;
  next[foundIndex] = replacement;
  return { ...ir, edges: next };
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
