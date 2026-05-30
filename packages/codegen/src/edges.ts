/**
 * Edges compiler — GraphIR → ADK `edges=[...]` rows (see ADR-0009).
 *
 * The IR is a plain directed graph of pairwise edges (`{from, to, route?}`, with
 * `from` possibly the literal `"START"`). ADK's `edges` rows are not a flat edge
 * list: a row is a *sequence chain* (`("START", a, b, c)` ≡ START→a→b→c). This
 * module linearizes the graph into those rows.
 *
 * It covers **linear-chain collapse** and **routers**: a single entry threads
 * through nodes with one in-edge and one out-edge each; a router terminates the
 * entry chain and emits a second row `(router, {route: target})` (the ADK route
 * map). Parallel fan-out (repeated START / non-router multi-out) and joins/merges
 * (fan-in) are rejected with a clear error so later slices fail loud rather than
 * emit wrong code.
 */
import type { Edge, GraphIR, GraphNode } from "@graphical-agents/ir";

/** The literal START sentinel that opens a graph entry row. */
export const START = "START";

/** One route→target entry in a router's ADK route map. */
export interface RouteEntry {
  readonly route: string;
  readonly target: string;
}

/**
 * One member of an ADK edges row: the START sentinel, a node symbol, or a router
 * route map (`{"ROUTE": target, ...}`) — the dict that follows the router symbol.
 */
export type RowMember =
  | { readonly kind: "start" }
  | { readonly kind: "node"; readonly name: string }
  | { readonly kind: "routeMap"; readonly entries: readonly RouteEntry[] };

/** An ADK `edges` row — a sequence chain, rendered as a Python tuple. */
export type EdgeRow = readonly RowMember[];

/** Raised when the graph uses a construct the current slice cannot linearize. */
export class EdgesCompilerError extends Error {
  override name = "EdgesCompilerError";
}

/** Linearize the IR graph into ADK edge rows. */
export function compileEdges(ir: GraphIR): EdgeRow[] {
  const nodeById = new Map<string, GraphNode>();
  for (const node of ir.nodes) nodeById.set(node.id, node);

  rejectUnsupported(ir);

  // Index outgoing edges per node and in-degree per node. A START edge is an
  // entry point; it still counts toward the target's in-degree (so a node fed by
  // both START and another node reads as a merge, not a linear continuation).
  const outEdges = new Map<string, Edge[]>();
  const inDegree = new Map<string, number>();
  const startTargets: string[] = [];
  for (const edge of ir.edges) {
    if (edge.from === START) {
      startTargets.push(edge.to);
    } else {
      const list = outEdges.get(edge.from);
      if (list) list.push(edge);
      else outEdges.set(edge.from, [edge]);
    }
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  if (startTargets.length === 0) {
    throw new EdgesCompilerError("no START edge: the graph has no entry point");
  }
  if (startTargets.length > 1) {
    throw new EdgesCompilerError(
      "multiple START edges: parallel fan-out is not handled by the linear-chain slice",
    );
  }

  const nodeOf = (id: string): GraphNode => {
    const node = nodeById.get(id);
    if (!node) throw new EdgesCompilerError(`edge references unknown node id "${id}"`);
    return node;
  };

  // Walk the linear successor chain from the single START target. A router
  // terminates the entry chain and contributes a second row (its route map).
  const rows: EdgeRow[] = [];
  const members: RowMember[] = [{ kind: "start" }];
  let cur = startTargets[0];
  for (;;) {
    const node = nodeOf(cur);
    members.push({ kind: "node", name: node.name });
    if (node.type === "router") {
      rows.push(buildRouteMapRow(node, outEdges.get(cur) ?? [], outEdges, nodeOf));
      break; // the router closes the entry chain; branches live in its route row
    }
    const outs = outEdges.get(cur) ?? [];
    if (outs.length === 0) break; // chain end
    if (outs.length > 1) {
      throw new EdgesCompilerError(
        `node "${node.name}" fans out to ${outs.length} edges; ` +
          "branch/parallel is not handled by this slice",
      );
    }
    const next = outs[0].to;
    if ((inDegree.get(next) ?? 0) > 1) {
      throw new EdgesCompilerError(
        `node "${nodeOf(next).name}" has multiple in-edges; ` +
          "joins/merges are not handled by this slice",
      );
    }
    cur = next;
  }

  rows.unshift(members);
  return rows;
}

/**
 * Build a router's route-map row `(router, {route: target})`. Entries follow the
 * router's **declared `routes` order** (deterministic), each mapped to the target
 * named by its labelled out-edge. Branch targets must be terminal in this slice —
 * a target with its own out-edges is a continuation we don't yet linearize.
 */
function buildRouteMapRow(
  router: GraphNode,
  outs: readonly Edge[],
  outEdges: ReadonlyMap<string, Edge[]>,
  nodeOf: (id: string) => GraphNode,
): EdgeRow {
  const declared = router.type === "router" ? router.config.routes : [];
  const targetByRoute = new Map<string, string>(); // route label -> target node id
  for (const edge of outs) {
    if (edge.route !== undefined) targetByRoute.set(edge.route, edge.to);
  }

  const entries: RouteEntry[] = declared.map((route) => {
    const targetId = targetByRoute.get(route);
    if (targetId === undefined) {
      throw new EdgesCompilerError(
        `router "${router.name}" route "${route}" has no out-edge`,
      );
    }
    if ((outEdges.get(targetId) ?? []).length > 0) {
      throw new EdgesCompilerError(
        `router "${router.name}" branch target "${nodeOf(targetId).name}" has ` +
          "out-edges; branch continuations are not handled by this slice",
      );
    }
    return { route, target: nodeOf(targetId).name };
  });

  return [{ kind: "node", name: router.name }, { kind: "routeMap", entries }];
}

/** Render compiled rows as the Python `edges=[...]` source fragment. */
export function renderEdgeRows(rows: readonly EdgeRow[]): string {
  const renderMember = (m: RowMember): string => {
    switch (m.kind) {
      case "start":
        return `"${START}"`;
      case "node":
        return m.name;
      case "routeMap":
        return `{${m.entries.map((e) => `"${e.route}": ${e.target}`).join(", ")}}`;
    }
  };
  const renderRow = (row: EdgeRow): string => `(${row.map(renderMember).join(", ")})`;
  return `edges=[${rows.map(renderRow).join(", ")}]`;
}

/** Reject constructs this slice cannot linearize, with an actionable message. */
function rejectUnsupported(ir: GraphIR): void {
  for (const node of ir.nodes) {
    if (node.type === "join" || node.type === "humanInput") {
      throw new EdgesCompilerError(
        `node "${node.name}" of type "${node.type}" is not handled by this slice`,
      );
    }
  }
}
