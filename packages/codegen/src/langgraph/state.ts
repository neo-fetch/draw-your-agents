/**
 * LangGraph target — state design and dataflow planning (ADR-0045/0046).
 *
 * LangGraph has no positional output→input piping: all data flows through a
 * shared state object. The mapping that preserves the IR's "one output per
 * node" semantics is **one state key per node output** (`<node_name>_output`),
 * plus one reserved entry key (`workflow_input`). Because node names are
 * globally unique (ADR-0017), no two nodes — parallel branches included — ever
 * write the same key, so no reducers are needed.
 *
 * `planGraph` computes, per graph (root or nested sub-graph), everything the
 * emitters need: each node's input key (which upstream key it reads), the
 * TypeRef stored under every key, join fan-ins, and the leaf set (nodes with
 * no out-edges, which wire to END).
 */
import type {
  Edge,
  GraphIR,
  GraphNode,
  JoinNode,
  SchemaDef,
  TypeRef,
} from "@graphical-agents/ir";
import { resolveRef, scalarType, type Fragment } from "../fragments.ts";
import { CodegenError, type ImportReq } from "../python.ts";

/** Reserved state key: the workflow's entry input, written by the caller. */
export const WORKFLOW_INPUT = "workflow_input";

/** Sentinel TypeRef for a join node's output — a dict keyed by upstream name. */
export const DICT_REF = "__dict__";

/** The state key a node writes its single output to. */
export function outputKey(node: GraphNode): string {
  return `${node.name}_output`;
}

/** State class symbol per graph: `WorkflowState` for the root, Pascal+State otherwise. */
export function stateClassName(symbol: string): string {
  if (symbol === "root_agent") return "WorkflowState";
  const pascal = symbol
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
  return `${pascal}State`;
}

/**
 * The single leaf (no out-edges) of a nested sub-graph — its output key is what
 * the parent's subgraph wrapper returns. Root graphs may have several leaves
 * (router branches all wire to END); nested graphs must have exactly one, or
 * the parent has no well-defined output to forward.
 */
export function singleLeaf(g: GraphIR): GraphNode {
  const leaves = findLeaves(g);
  if (leaves.length !== 1) {
    throw new CodegenError(
      `nested workflow "${g.name}" must have exactly one leaf node ` +
        `(found ${leaves.length}) — its output feeds the parent graph`,
    );
  }
  return leaves[0]!;
}

/**
 * The TypeRef stored under a node's output key: the node's declared output
 * type, `DICT_REF` for joins (upstream-name-keyed dict), the route label
 * (`"str"`) for routers, and — for a nested workflow — its single leaf's
 * output type, resolved recursively.
 */
export function nodeOutputRef(node: GraphNode): TypeRef {
  switch (node.type) {
    case "agent":
      return node.config.outputSchemaRef;
    case "function":
    case "tool":
      return node.config.outputType;
    case "router":
      return "str";
    case "humanInput":
      return node.config.responseSchemaRef ?? "str";
    case "loop":
      return node.config.payloadType;
    case "join":
      return DICT_REF;
    case "workflow":
      return nodeOutputRef(singleLeaf(node.config.graph));
    default: {
      const exhaustive: never = node;
      throw new CodegenError(
        `node of unknown type "${(exhaustive as GraphNode).type}"`,
      );
    }
  }
}

/** Everything the emitters need to know about one graph (root or nested). */
export interface GraphPlan {
  readonly graph: GraphIR;
  /** `root_agent` for the root, otherwise the workflow node's name. */
  readonly symbol: string;
  readonly isRoot: boolean;
  readonly stateClass: string;
  /** nodeId → the state key the node reads its input from (absent for joins). */
  readonly inputKeyOf: ReadonlyMap<string, string>;
  /** state key → the TypeRef of the value stored there. */
  readonly keyRefOf: ReadonlyMap<string, TypeRef>;
  /** join nodeId → its upstream nodes, in IR edge order. */
  readonly joinUpstreams: ReadonlyMap<string, readonly GraphNode[]>;
  /** Nodes with no out-edges — each wires to END. */
  readonly leaves: readonly GraphNode[];
}

function findLeaves(g: GraphIR): GraphNode[] {
  const hasOut = new Set<string>(g.edges.map((e) => e.from));
  return g.nodes.filter((n) => !hasOut.has(n.id));
}

/**
 * Compute the dataflow plan for one graph. Input-key rules:
 * - entry node (START in-edge) → `workflow_input`;
 * - downstream of a router → the **router's own** input key (the route label
 *   is control flow, not data — the branch consumes what the router examined);
 * - otherwise → the single upstream node's output key.
 * Joins read several keys (via `joinUpstreams`), so they get no input key.
 */
export function planGraph(g: GraphIR, symbol: string, isRoot: boolean): GraphPlan {
  const nodeById = new Map<string, GraphNode>();
  for (const node of g.nodes) nodeById.set(node.id, node);
  const nodeOf = (id: string): GraphNode => {
    const node = nodeById.get(id);
    if (!node) throw new CodegenError(`edge references unknown node id "${id}"`);
    return node;
  };

  const inEdges = new Map<string, Edge[]>();
  for (const edge of g.edges) {
    const list = inEdges.get(edge.to);
    if (list) list.push(edge);
    else inEdges.set(edge.to, [edge]);
  }

  const joinUpstreams = new Map<string, readonly GraphNode[]>();
  for (const node of g.nodes) {
    if (node.type === "join") {
      const ins = inEdges.get(node.id) ?? [];
      joinUpstreams.set(
        node.id,
        ins.filter((e) => e.from !== "START").map((e) => nodeOf(e.from)),
      );
    }
  }

  // Resolve input keys with memoized recursion: a router's branch target needs
  // the router's own input key, which may itself chain upstream.
  const inputKeyOf = new Map<string, string>();
  const resolveInputKey = (node: GraphNode): string => {
    const cached = inputKeyOf.get(node.id);
    if (cached) return cached;
    const ins = inEdges.get(node.id) ?? [];
    let key: string;
    if (ins.some((e) => e.from === "START") || ins.length === 0) {
      key = WORKFLOW_INPUT;
    } else {
      const upstream = nodeOf(ins[0]!.from);
      key = upstream.type === "router" ? resolveInputKey(upstream) : outputKey(upstream);
    }
    inputKeyOf.set(node.id, key);
    return key;
  };
  for (const node of g.nodes) {
    if (node.type !== "join") resolveInputKey(node);
  }

  const keyRefOf = new Map<string, TypeRef>([[WORKFLOW_INPUT, "str"]]);
  for (const node of g.nodes) keyRefOf.set(outputKey(node), nodeOutputRef(node));

  return {
    graph: g,
    symbol,
    isRoot,
    stateClass: stateClassName(symbol),
    inputKeyOf,
    keyRefOf,
    joinUpstreams,
    leaves: findLeaves(g),
  };
}

/** Python annotation for the value stored under a state key. */
function keyAnnotation(
  ref: TypeRef,
  schemas: ReadonlyMap<string, SchemaDef>,
): { py: string; imports: ImportReq[] } {
  if (ref === DICT_REF) return { py: "dict", imports: [] };
  if (schemas.has(ref)) return resolveRef(ref, schemas);
  return scalarType(ref as Parameters<typeof scalarType>[0]);
}

/**
 * state.py: one `TypedDict(total=False)` per graph — `total=False` because
 * keys are filled in as nodes run (each node returns a partial update).
 * `typing_extensions.TypedDict` per the LangGraph docs (required for full
 * interop on Python <3.12; always present via the pydantic dependency).
 */
export function renderStateClass(
  plan: GraphPlan,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const imports: ImportReq[] = [{ module: "typing_extensions", names: ["TypedDict"] }];
  const lines: string[] = [`    ${WORKFLOW_INPUT}: str`];
  for (const node of plan.graph.nodes) {
    const ref = plan.keyRefOf.get(outputKey(node))!;
    const annotation = keyAnnotation(ref, schemas);
    imports.push(...annotation.imports);
    lines.push(`    ${outputKey(node)}: ${annotation.py}`);
  }
  return {
    imports,
    code: `class ${plan.stateClass}(TypedDict, total=False):\n${lines.join("\n")}\n`,
  };
}
