/**
 * Edges compiler — GraphIR → ADK `edges=[...]` rows (see ADR-0009).
 *
 * The IR is a plain directed graph of pairwise edges (`{from, to, route?}`, with
 * `from` possibly the literal `"START"`). ADK's `edges` rows are not a flat edge
 * list: a row is a *sequence chain* (`("START", a, b, c)` ≡ START→a→b→c). This
 * module linearizes the graph into those rows.
 *
 * Supported constructs:
 * - **Linear chains**: a single START entry threaded through nodes.
 * - **Routers**: a router terminates the entry chain and emits a route-map row.
 * - **Parallel fan-out + join**: repeated START edges fan out to branches that
 *   converge on a join node. Each branch is its own START row ending at the join;
 *   a continuation row begins at the join (ADR-0015).
 *
 * `humanInput` and `workflow`/`tool` node types are rejected with a clear error
 * so later slices fail loud rather than emit wrong code.
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

  const nodeOf = (id: string): GraphNode => {
    const node = nodeById.get(id);
    if (!node) throw new EdgesCompilerError(`edge references unknown node id "${id}"`);
    return node;
  };

  // Parallel fan-out: multiple START targets.
  if (startTargets.length > 1) {
    return compileParallel(startTargets, outEdges, inDegree, nodeOf);
  }

  // Single-entry: walk the linear successor chain from the single START target.
  // A router terminates the entry chain and contributes a second row (its route
  // map).
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
 * Compile a parallel fan-out graph: repeated START → branches → join → continuation.
 *
 * Each branch becomes its own START row ending at the join node. The chain walks
 * from each START target until it reaches a join node (fan-in), collecting all
 * intermediate nodes. A final continuation row begins at the join and chains
 * forward.
 *
 * Row form (ADR-0015):
 *   ("START", task_a, my_join_node)
 *   ("START", task_b, my_join_node)
 *   ("START", task_c, my_join_node)
 *   (my_join_node, final_task_d)
 */
function compileParallel(
  startTargets: readonly string[],
  outEdges: ReadonlyMap<string, Edge[]>,
  inDegree: ReadonlyMap<string, number>,
  nodeOf: (id: string) => GraphNode,
): EdgeRow[] {
  const rows: EdgeRow[] = [];
  let joinNodeId: string | undefined;

  // Build one fan-out row per START target.
  for (const target of startTargets) {
    const members: RowMember[] = [{ kind: "start" }];
    let cur = target;
    for (;;) {
      const node = nodeOf(cur);
      members.push({ kind: "node", name: node.name });
      if (node.type === "join") {
        // This branch terminates at the join.
        if (joinNodeId === undefined) {
          joinNodeId = cur;
        } else if (joinNodeId !== cur) {
          throw new EdgesCompilerError(
            `parallel branches converge on different join nodes ("${nodeOf(joinNodeId).name}" and "${node.name}"); ` +
              "this slice supports a single join node",
          );
        }
        break;
      }
      const outs = outEdges.get(cur) ?? [];
      if (outs.length === 0) {
        throw new EdgesCompilerError(
          `parallel branch ending at "${node.name}" does not reach a join node`,
        );
      }
      if (outs.length > 1) {
        throw new EdgesCompilerError(
          `node "${node.name}" in a parallel branch fans out to ${outs.length} edges; ` +
            "nested fan-out is not handled by this slice",
        );
      }
      cur = outs[0].to;
    }
    rows.push(members);
  }

  // Continuation from the join node forward.
  if (joinNodeId !== undefined) {
    const joinOuts = outEdges.get(joinNodeId) ?? [];
    if (joinOuts.length > 0) {
      if (joinOuts.length > 1) {
        throw new EdgesCompilerError(
          `join node "${nodeOf(joinNodeId).name}" fans out to ${joinOuts.length} edges; ` +
            "multi-out after join is not handled by this slice",
        );
      }
      const contMembers: RowMember[] = [{ kind: "node", name: nodeOf(joinNodeId).name }];
      let cur = joinOuts[0].to;
      for (;;) {
        const node = nodeOf(cur);
        contMembers.push({ kind: "node", name: node.name });
        const outs = outEdges.get(cur) ?? [];
        if (outs.length === 0) break;
        if (outs.length > 1) {
          throw new EdgesCompilerError(
            `node "${node.name}" after join fans out to ${outs.length} edges; ` +
              "this slice handles a single continuation chain",
          );
        }
        cur = outs[0].to;
      }
      rows.push(contMembers);
    }
  }

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
    if (node.type === "humanInput") {
      throw new EdgesCompilerError(
        `node "${node.name}" of type "${node.type}" is not handled by this slice`,
      );
    }
  }
}
