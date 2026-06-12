/**
 * Pure helpers for navigating and editing nested workflow sub-graphs
 * (ADR-0050). A "subgraph path" is the list of workflow node ids from the
 * root IR down to the graph being edited — `[]` means the root itself.
 *
 * Mutations are **path-scoped** on purpose: node ids are only conventionally
 * global (`DUPLICATE_NODE_ID` is per-graph, see the note in `addNode.ts`), so
 * a hand-loaded IR may legally reuse an id across levels. Resolving a path
 * segment-by-segment is the only id lookup that cannot land on the wrong
 * node.
 *
 * React-free, zustand-free, DOM-free — joins the ADR-0022 reducer family and
 * is exercised under `node --test` from a cold checkout.
 */
import type { GraphIR, WorkflowNode } from "@graphical-agents/ir";

function workflowAt(g: GraphIR, id: string): WorkflowNode | undefined {
  return g.nodes.find(
    (n): n is WorkflowNode => n.id === id && n.type === "workflow",
  );
}

/**
 * The GraphIR at `path`. `[]` returns `ir` itself (same reference). Returns
 * the existing nested object — zero allocation, so zustand selectors built
 * on it stay referentially stable across unrelated renders. `undefined`
 * when any segment is missing or isn't a workflow node.
 */
export function graphAtPath(
  ir: GraphIR,
  path: readonly string[],
): GraphIR | undefined {
  let g: GraphIR = ir;
  for (const seg of path) {
    const wf = workflowAt(g, seg);
    if (!wf || wf.config.graph === null || typeof wf.config.graph !== "object") {
      return undefined;
    }
    g = wf.config.graph;
  }
  return g;
}

/**
 * Immutably replace the graph at `path` with `fn(graph)`. Returns the SAME
 * `ir` reference when the path is invalid or `fn` returns its input
 * unchanged (the no-op short-circuit convention of `irEdges.ts`). Only the
 * spine is rebuilt: ancestor workflow nodes along the path get new objects;
 * sibling nodes keep referential identity so React Flow doesn't re-render
 * unrelated cards.
 */
export function updateGraphAtPath(
  ir: GraphIR,
  path: readonly string[],
  fn: (g: GraphIR) => GraphIR,
): GraphIR {
  if (path.length === 0) return fn(ir);
  const [head, ...rest] = path;
  const wf = workflowAt(ir, head);
  if (!wf) return ir;
  const nextSub = updateGraphAtPath(wf.config.graph, rest, fn);
  if (nextSub === wf.config.graph) return ir;
  const nodes = ir.nodes.map((n) =>
    n === wf
      ? { ...wf, config: { ...wf.config, graph: nextSub } }
      : n,
  );
  return { ...ir, nodes };
}

/**
 * Breadcrumb items for the workflow nodes along `path` (the root segment is
 * not included — it renders from `ir.name`). `undefined` when the path is
 * invalid.
 */
export function breadcrumbItems(
  ir: GraphIR,
  path: readonly string[],
): Array<{ id: string; name: string }> | undefined {
  const out: Array<{ id: string; name: string }> = [];
  let g: GraphIR = ir;
  for (const seg of path) {
    const wf = workflowAt(g, seg);
    if (!wf) return undefined;
    out.push({ id: wf.id, name: wf.name });
    g = wf.config.graph;
  }
  return out;
}

/**
 * Truncate `path` at the first occurrence of `deletedId` (defensive: a
 * dev-window dispatch could delete an ancestor workflow node out from under
 * the active path). Same array reference when nothing matched.
 */
export function prunePath(
  path: readonly string[],
  deletedId: string,
): readonly string[] {
  const i = path.indexOf(deletedId);
  return i === -1 ? path : path.slice(0, i);
}

/**
 * Resolve a validator finding `nodeId` ("n_outer/n_inner/...", the
 * `pathPrefix` convention of ADR-0017) to a navigable location: every prefix
 * segment must be a workflow node in successive graphs; the final segment
 * must be a node in the graph it lands in. When only a prefix resolves,
 * falls back to the deepest valid location (the enclosing workflow node) —
 * the recursive analog of `findingTarget.ts`'s top-level fallback. `null`
 * when nothing resolves.
 */
export function resolveFindingPath(
  ir: GraphIR,
  findingNodeId: string | undefined,
): { path: string[]; nodeId: string } | null {
  if (!findingNodeId) return null;
  const segs = findingNodeId.split("/");
  const path: string[] = [];
  let g: GraphIR = ir;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;
    if (isLast && g.nodes.some((n) => n.id === seg)) {
      return { path, nodeId: seg };
    }
    const wf = workflowAt(g, seg);
    if (!wf) {
      // Fall back to the deepest workflow node we resolved into: select the
      // segment we're currently *inside* (the last entry of `path`) at its
      // parent path.
      if (path.length === 0) return null;
      const nodeId = path[path.length - 1];
      return { path: path.slice(0, -1), nodeId };
    }
    if (isLast) return { path, nodeId: wf.id };
    path.push(wf.id);
    g = wf.config.graph;
  }
  return null;
}

/**
 * Shared selector: the graph the editing surfaces (canvas, palette,
 * inspector, schema panel) operate on. Falls back to the root when the path
 * is transiently invalid so a stale path renders the root instead of
 * crashing.
 */
export function selectActiveGraph(s: {
  ir: GraphIR;
  subgraphPath: readonly string[];
}): GraphIR {
  return graphAtPath(s.ir, s.subgraphPath) ?? s.ir;
}
