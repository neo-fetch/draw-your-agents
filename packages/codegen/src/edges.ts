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
 * - **Routers**: a router closes the chain it sits in and emits a route-map row.
 *   A branch target that is not terminal gets its own **continuation row headed
 *   by that target** (ADR-0054) — the same interior-row-head rule ADR-0015's
 *   `(join, continuation)` row and ADR-0048's fan-out rows already use. A branch
 *   target that is itself a router chains a further route-map row.
 * - **Parallel fan-out + join**: a fan-out point (repeated START edges, or an
 *   interior node with multiple out-edges) fans out to branches that converge on
 *   a join node. Each branch is its own row headed by the fan-out point — a
 *   repeated row head means fan-out from that node, the same rule that governs
 *   repeated `"START"`. A continuation row begins at the join (ADR-0015,
 *   ADR-0048).
 * - **HumanInput**: a humanInput node is a plain linear-chain member — it
 *   consumes the previous node's output, yields a `RequestInput`, and forwards
 *   the user's response (ADR-0016). It needs no new `RowMember` kind.
 * - **Nested Workflow**: a `workflow` node is also a plain linear-chain member
 *   in its parent's rows (ADR-0018) — `compileEdges` does **not** recurse into
 *   `config.graph`. The project assembler walks workflow nodes separately and
 *   invokes `compileEdges` per sub-graph, emitting each as its own
 *   `<symbol> = Workflow(...)` assignment in `workflow.py`.
 *
 * `tool` remains out of v1 scope and is filtered by the assembler's type
 * whitelist before reaching codegen.
 */
import type { Edge, GraphIR, GraphNode, RouterNode } from "@graphical-agents/ir";

/** The literal START sentinel that opens a graph entry row. */
export const START = "START";

/**
 * Python symbol a node contributes to the `edges=[…]` row. Most node types
 * use the IR `name` directly; `loop` nodes expose `<name>_orchestrator` from
 * `loops.py` (ADR-0039), so the edge row references that symbol instead.
 */
function rowSymbol(node: GraphNode): string {
  return node.type === "loop" ? `${node.name}_orchestrator` : node.name;
}

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

/** Everything the chain walk needs, threaded through the mutually recursive helpers. */
interface WalkCtx {
  readonly outEdges: ReadonlyMap<string, Edge[]>;
  readonly inDegree: ReadonlyMap<string, number>;
  readonly nodeOf: (id: string) => GraphNode;
  /**
   * Nodes whose forward rows have already been emitted. Two declared routes may
   * legally share one branch target (ADR-0027 allows `{"A": t, "B": t}`), and
   * that target's continuation belongs in exactly one row.
   */
  readonly expanded: Set<string>;
}

/** Linearize the IR graph into ADK edge rows. */
export function compileEdges(ir: GraphIR): EdgeRow[] {
  const nodeById = new Map<string, GraphNode>();
  for (const node of ir.nodes) nodeById.set(node.id, node);

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

  // Parallel fan-out from START: multiple START targets.
  if (startTargets.length > 1) {
    return compileFanOut({ kind: "start" }, startTargets, outEdges, nodeOf);
  }

  // Single-entry: walk the linear successor chain from the single START target.
  return compileChain({ kind: "start" }, startTargets[0], {
    outEdges,
    inDegree,
    nodeOf,
    expanded: new Set(),
  });
}

/**
 * One sequence-chain row: `head` followed by `firstId` and every node linearly
 * downstream of it, plus whatever rows that chain spawns (a router's route map
 * and branch continuations, or a fan-out region). The returned chain row is
 * always first.
 */
function compileChain(head: RowMember, firstId: string, ctx: WalkCtx): EdgeRow[] {
  const members: RowMember[] = [head];
  const spawned: EdgeRow[] = [];
  let cur = firstId;
  for (;;) {
    const node = ctx.nodeOf(cur);
    members.push({ kind: "node", name: rowSymbol(node) });
    const outs = ctx.outEdges.get(cur) ?? [];
    // Only a plain single-successor node continues this row. A router closes it
    // (its branches live in the route map), and so does a terminal node or a
    // fan-out point — `expand` owns whatever follows in each of those cases.
    if (node.type === "router" || outs.length !== 1) {
      spawned.push(...expand(node, ctx));
      break;
    }
    const next = outs[0].to;
    if ((ctx.inDegree.get(next) ?? 0) > 1) {
      throw new EdgesCompilerError(
        `node "${ctx.nodeOf(next).name}" has multiple in-edges; ` +
          "joins/merges are not handled by this slice",
      );
    }
    cur = next;
  }
  return [members, ...spawned];
}

/**
 * The rows that continue *after* `node`, which some earlier row already placed.
 * The single place that decides what follows a node:
 * - router      → its route-map row, plus one expansion per branch target;
 * - terminal    → nothing;
 * - >1 out-edge → a fan-out region headed by the node (ADR-0048);
 * - 1 out-edge  → a continuation row headed by the node.
 *
 * Emitted at most once per node — see `WalkCtx.expanded`.
 */
function expand(node: GraphNode, ctx: WalkCtx): EdgeRow[] {
  if (ctx.expanded.has(node.id)) return [];
  ctx.expanded.add(node.id);

  if (node.type === "router") {
    const targets = routeTargets(node, ctx.outEdges.get(node.id) ?? []);
    const rows: EdgeRow[] = [buildRouteMapRow(node, targets, ctx.nodeOf)];
    // Branch continuations follow the declared route order, so the row order is
    // deterministic. A branch target that is itself a router recurses here.
    for (const { targetId } of targets) {
      rows.push(...expand(ctx.nodeOf(targetId), ctx));
    }
    return rows;
  }

  const outs = ctx.outEdges.get(node.id) ?? [];
  if (outs.length === 0) return []; // terminal
  const head: RowMember = { kind: "node", name: rowSymbol(node) };
  if (outs.length > 1) {
    return compileFanOut(
      head,
      outs.map((e) => e.to),
      ctx.outEdges,
      ctx.nodeOf,
    );
  }
  const next = outs[0].to;
  if ((ctx.inDegree.get(next) ?? 0) > 1) {
    throw new EdgesCompilerError(
      `node "${ctx.nodeOf(next).name}" has multiple in-edges; ` +
        "joins/merges are not handled by this slice",
    );
  }
  return compileChain(head, next, ctx);
}

/**
 * Compile a parallel fan-out region: fan-out point → branches → join → continuation.
 *
 * `head` is the fan-out point — the START sentinel (repeated START edges,
 * ADR-0015) or an interior node with multiple out-edges (mid-graph fan-out,
 * ADR-0048). Each branch becomes its own row headed by `head` and ending at the
 * join node. The chain walks from each branch target until it reaches a join
 * node (fan-in), collecting all intermediate nodes. A final continuation row
 * begins at the join and chains forward.
 *
 * Row form (ADR-0015 / ADR-0048):
 *   ("START", task_a, my_join_node)        (prep, task_a, my_join)
 *   ("START", task_b, my_join_node)   or   (prep, task_b, my_join)
 *   (my_join_node, final_task_d)           (my_join, final_task)
 */
function compileFanOut(
  head: RowMember,
  branchTargets: readonly string[],
  outEdges: ReadonlyMap<string, Edge[]>,
  nodeOf: (id: string) => GraphNode,
): EdgeRow[] {
  const rows: EdgeRow[] = [];
  let joinNodeId: string | undefined;

  // Build one fan-out row per branch target.
  for (const target of branchTargets) {
    const members: RowMember[] = [head];
    let cur = target;
    for (;;) {
      const node = nodeOf(cur);
      members.push({ kind: "node", name: rowSymbol(node) });
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
      const contMembers: RowMember[] = [{ kind: "node", name: rowSymbol(nodeOf(joinNodeId)) }];
      let cur = joinOuts[0].to;
      for (;;) {
        const node = nodeOf(cur);
        contMembers.push({ kind: "node", name: rowSymbol(node) });
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

/** A router's branch targets in **declared `routes` order** — the deterministic order. */
interface RouteTarget {
  readonly route: string;
  readonly targetId: string;
}

/**
 * Resolve each declared route to the node id named by its labelled out-edge.
 * The validator guarantees the declared set and the labelled set match
 * (IR-SCHEMA invariant 7); a mismatch here is a malformed IR, so it throws.
 */
function routeTargets(router: RouterNode, outs: readonly Edge[]): RouteTarget[] {
  const targetByRoute = new Map<string, string>(); // route label -> target node id
  for (const edge of outs) {
    if (edge.route !== undefined) targetByRoute.set(edge.route, edge.to);
  }
  return router.config.routes.map((route) => {
    const targetId = targetByRoute.get(route);
    if (targetId === undefined) {
      throw new EdgesCompilerError(
        `router "${router.name}" route "${route}" has no out-edge`,
      );
    }
    return { route, targetId };
  });
}

/**
 * Build a router's route-map row `(router, {route: target})`. A branch target
 * need not be terminal — a target with its own out-edges gets a continuation row
 * of its own, built by `expand` (ADR-0054).
 */
function buildRouteMapRow(
  router: RouterNode,
  targets: readonly RouteTarget[],
  nodeOf: (id: string) => GraphNode,
): EdgeRow {
  const entries: RouteEntry[] = targets.map(({ route, targetId }) => ({
    route,
    target: rowSymbol(nodeOf(targetId)),
  }));
  return [{ kind: "node", name: rowSymbol(router) }, { kind: "routeMap", entries }];
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

