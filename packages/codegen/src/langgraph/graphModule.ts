/**
 * LangGraph target — graph.py wiring emitter (ADR-0045/0046), the analog of
 * the ADK edges renderer. Where ADK rows are linearized chains, LangGraph's
 * `add_edge` is pairwise — so wiring is emitted **directly from the IR edges**
 * (lossless, order-preserving). Shape rules stay single-sourced: the assembler
 * runs `compileEdges` per graph as a gate first, so both targets accept
 * exactly the same topologies.
 *
 * Per graph:
 * - one `add_node` per node (`defer=True` on joins — LangGraph's native
 *   "wait for all pending branches" join, no failsafe machinery);
 * - `add_edge` per IR edge (`START` sentinel for entry edges); a router's
 *   labeled out-edges collapse into one `add_conditional_edges` whose mapping
 *   follows the declared route order;
 * - every leaf (no out-edges) wires to `END`;
 * - `compile()` — with the checkpointer on the root when the project has any
 *   humanInput node (subgraphs always compile bare and inherit it).
 */
import type { GraphNode, RouterNode, WorkflowNode } from "@graphical-agents/ir";
import type { Fragment } from "../fragments.ts";
import { CodegenError, indent, pyStr, type ImportReq } from "../python.ts";
import { outputKey, singleLeaf, WORKFLOW_INPUT, type GraphPlan } from "./state.ts";

/** The builder variable for a graph: `builder` at the root, prefixed when nested. */
function builderVar(plan: GraphPlan): string {
  return plan.isRoot ? "builder" : `${plan.symbol}_builder`;
}

/** The compiled-graph variable: `graph` at the root, prefixed when nested. */
export function graphVar(plan: GraphPlan): string {
  return plan.isRoot ? "graph" : `${plan.symbol}_graph`;
}

function renderConditionalEdges(
  builder: string,
  router: RouterNode,
  targetByRoute: ReadonlyMap<string, string>,
): string {
  const entries = router.config.routes.map((route) => {
    const target = targetByRoute.get(route);
    if (!target) {
      throw new CodegenError(
        `router "${router.name}": declared route "${route}" has no out-edge`,
      );
    }
    return `${pyStr(route)}: ${pyStr(target)},`;
  });
  return [
    `${builder}.add_conditional_edges(`,
    indent(
      [
        `${pyStr(router.name)},`,
        `lambda state: state[${pyStr(outputKey(router))}],`,
        `{\n${indent(entries.join("\n"))}\n},`,
      ].join("\n"),
    ),
    `)`,
  ].join("\n");
}

/**
 * The builder/edges/compile block for one graph. Returned as a single "stmt"
 * body — internal blank lines separate the add_node, edge, and compile groups.
 */
export function renderGraphWiring(plan: GraphPlan, checkpointer: boolean): Fragment {
  const builder = builderVar(plan);
  const imports: ImportReq[] = [
    { module: "langgraph.graph", names: ["END", "START", "StateGraph"] },
    { module: "state", names: [plan.stateClass] },
  ];
  if (checkpointer) {
    imports.push({ module: "langgraph.checkpoint.memory", names: ["InMemorySaver"] });
  }

  const nodeById = new Map<string, GraphNode>();
  for (const node of plan.graph.nodes) nodeById.set(node.id, node);
  const nameOf = (id: string): string => {
    const node = nodeById.get(id);
    if (!node) throw new CodegenError(`edge references unknown node id "${id}"`);
    return node.name;
  };

  const addNodes = plan.graph.nodes.map((node) => {
    const defer = node.type === "join" ? ", defer=True" : "";
    return `${builder}.add_node(${pyStr(node.name)}, ${node.name}${defer})`;
  });

  const edgeLines: string[] = [];
  const routersDone = new Set<string>();
  for (const edge of plan.graph.edges) {
    const fromNode = edge.from === "START" ? undefined : nodeById.get(edge.from);
    if (fromNode?.type === "router") {
      if (routersDone.has(fromNode.id)) continue;
      routersDone.add(fromNode.id);
      const targetByRoute = new Map<string, string>();
      for (const e of plan.graph.edges) {
        if (e.from === fromNode.id && e.route) targetByRoute.set(e.route, nameOf(e.to));
      }
      edgeLines.push(renderConditionalEdges(builder, fromNode, targetByRoute));
    } else {
      const from = edge.from === "START" ? "START" : pyStr(nameOf(edge.from));
      edgeLines.push(`${builder}.add_edge(${from}, ${pyStr(nameOf(edge.to))})`);
    }
  }
  for (const leaf of plan.leaves) {
    edgeLines.push(`${builder}.add_edge(${pyStr(leaf.name)}, END)`);
  }

  const compileCall = checkpointer
    ? `${builder}.compile(checkpointer=InMemorySaver())`
    : `${builder}.compile()`;

  const code = [
    `${builder} = StateGraph(${plan.stateClass})`,
    addNodes.join("\n"),
    ``,
    edgeLines.join("\n"),
    ``,
    `${graphVar(plan)} = ${compileCall}`,
  ].join("\n");
  return { imports, code: `${code}\n` };
}

/**
 * The parent-side wrapper node for a nested workflow (ADR-0046): state schemas
 * differ per graph, so the compiled subgraph is invoked behind a function that
 * maps the parent's upstream key → the sub-graph's `workflow_input`, and the
 * sub-graph's single leaf output → the workflow node's own output key.
 */
export function renderSubgraphWrapper(
  node: WorkflowNode,
  parentPlan: GraphPlan,
  subPlan: GraphPlan,
): Fragment {
  const inputKey = parentPlan.inputKeyOf.get(node.id);
  if (!inputKey) {
    throw new CodegenError(`workflow node "${node.name}" has no resolved input key`);
  }
  const leafKey = outputKey(singleLeaf(node.config.graph));
  const invokeArg = `{${pyStr(WORKFLOW_INPUT)}: state[${pyStr(inputKey)}]}`;
  const inline = `sub_state = ${graphVar(subPlan)}.invoke(${invokeArg})`;
  const invoke =
    4 + inline.length <= 88
      ? inline
      : `sub_state = ${graphVar(subPlan)}.invoke(\n${indent(invokeArg)}\n)`;

  const imports: ImportReq[] = [
    { module: "state", names: [parentPlan.stateClass] },
  ];
  const lines: string[] = [`def ${node.name}(state: ${parentPlan.stateClass}) -> dict:`];
  if (node.config.description) lines.push(indent(`"""${node.config.description}"""`));
  lines.push(
    indent(invoke),
    indent(`return {${pyStr(outputKey(node))}: sub_state[${pyStr(leafKey)}]}`),
  );
  return { imports, code: `${lines.join("\n")}\n` };
}
