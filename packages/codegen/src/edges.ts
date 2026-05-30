/**
 * Edges compiler — GraphIR → ADK `edges=[...]` rows (see ADR-0009).
 *
 * The IR is a plain directed graph of pairwise edges (`{from, to, route?}`, with
 * `from` possibly the literal `"START"`). ADK's `edges` rows are not a flat edge
 * list: a row is a *sequence chain* (`("START", a, b, c)` ≡ START→a→b→c). This
 * module linearizes the graph into those rows.
 *
 * Slice 1 covers **linear-chain collapse** only: a single entry that threads
 * through nodes with one in-edge and one out-edge each. Routers (route maps),
 * parallel fan-out (repeated START), and joins/merges (fan-in) are rejected with
 * a clear error so later slices fail loud rather than emit wrong code.
 */
import type { Edge, GraphIR, GraphNode } from "@graphical-agents/ir";

/** The literal START sentinel that opens a graph entry row. */
export const START = "START";

/** One member of an ADK edges row. Slice 1: the START sentinel or a node symbol. */
export type RowMember =
  | { readonly kind: "start" }
  | { readonly kind: "node"; readonly name: string };

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

  const nameOf = (id: string): string => {
    const node = nodeById.get(id);
    if (!node) throw new EdgesCompilerError(`edge references unknown node id "${id}"`);
    return node.name;
  };

  // Walk the unique linear successor chain from the single START target.
  const members: RowMember[] = [{ kind: "start" }];
  let cur = startTargets[0];
  for (;;) {
    members.push({ kind: "node", name: nameOf(cur) });
    const outs = outEdges.get(cur) ?? [];
    if (outs.length === 0) break; // chain end
    if (outs.length > 1) {
      throw new EdgesCompilerError(
        `node "${nameOf(cur)}" fans out to ${outs.length} edges; ` +
          "branch/parallel is not handled by the linear-chain slice",
      );
    }
    const next = outs[0].to;
    if ((inDegree.get(next) ?? 0) > 1) {
      throw new EdgesCompilerError(
        `node "${nameOf(next)}" has multiple in-edges; ` +
          "joins/merges are not handled by the linear-chain slice",
      );
    }
    cur = next;
  }

  return [members];
}

/** Render compiled rows as the Python `edges=[...]` source fragment. */
export function renderEdgeRows(rows: readonly EdgeRow[]): string {
  const renderMember = (m: RowMember): string =>
    m.kind === "start" ? `"${START}"` : m.name;
  const renderRow = (row: EdgeRow): string => `(${row.map(renderMember).join(", ")})`;
  return `edges=[${rows.map(renderRow).join(", ")}]`;
}

/** Reject constructs outside the linear-chain slice, with an actionable message. */
function rejectUnsupported(ir: GraphIR): void {
  for (const edge of ir.edges) {
    if (edge.route !== undefined) {
      throw new EdgesCompilerError(
        `edge ${edge.from}→${edge.to} carries route "${edge.route}"; ` +
          "routers are not handled by the linear-chain slice",
      );
    }
  }
  for (const node of ir.nodes) {
    if (node.type === "router" || node.type === "join" || node.type === "humanInput") {
      throw new EdgesCompilerError(
        `node "${node.name}" of type "${node.type}" is not handled by the linear-chain slice`,
      );
    }
  }
}
