/**
 * LangGraph project assembler (ADR-0045/0046) — GraphIR → a runnable LangGraph
 * (Python ≥3.10, langgraph 1.x) project file set. The structural mirror of the
 * ADK assembler in [../project.ts]: same Fragment plumbing, same flat global
 * namespace across nesting levels (ADR-0017), different module family:
 *
 *   state.py    one TypedDict per graph — `workflow_input` + one `<node>_output`
 *               key per node (ADR-0046 state-key dataflow)
 *   schemas.py  pydantic models (shared renderer with the ADK target)
 *   nodes.py    function / router / humanInput / tool / join node functions
 *   agents.py   agent node functions (lazy `init_chat_model`)
 *   loops.py    loop node functions (only when loop nodes exist)
 *   graph.py    StateGraph wiring + subgraph wrappers — the entry module
 *
 * Shape rules stay single-sourced: `compileEdges` runs per graph purely as a
 * gate (rows discarded), so both targets accept exactly the same topologies.
 */
import type {
  AgentNode,
  GraphIR,
  GraphNode,
  LoopNode,
  SchemaDef,
  WorkflowNode,
} from "@graphical-agents/ir";
import { compileEdges } from "../edges.ts";
import { indexSchemas, renderSchema, type Fragment } from "../fragments.ts";
import type { GeneratedProject } from "../project.ts";
import { header, joinModule, topologicalSchemas, walkAllNodes } from "../project.ts";
import { CodegenError, pyStr, renderImports, type ImportReq } from "../python.ts";
import {
  lgLoopSchemas,
  renderLgAgent,
  renderLgHumanInput,
  renderLgJoin,
  renderLgLoop,
  renderLgLoopConstants,
  renderLgRouter,
  renderLgStub,
} from "./fragments.ts";
import { renderGraphWiring, renderSubgraphWrapper } from "./graphModule.ts";
import {
  outputKey,
  planGraph,
  renderStateClass,
  WORKFLOW_INPUT,
  type GraphPlan,
} from "./state.ts";

/** The LangGraph project's own module set, for isort-style import grouping. */
const LG_LOCAL = new Set(["state", "schemas", "nodes", "agents", "loops", "graph"]);

// langgraph/langchain float within the verified 1.x majors (ADR-0046);
// langchain-google-genai backs the `google_genai:` model-id prefix.
const REQUIREMENTS = "langgraph>=1.2,<2\nlangchain>=1.3,<2\nlangchain-google-genai\npytest\n";

const ENV_EXAMPLE = `# Google Gemini credentials — copy this file to .env and fill in your key.
GOOGLE_API_KEY=
`;

/**
 * Collect one GraphPlan per graph (root + each nested workflow), deepest-first
 * so a sub-graph's wiring is emitted before the parent wiring that references
 * its wrapper. Each graph passes through `compileEdges` as the shape gate.
 */
function collectGraphPlans(ir: GraphIR): GraphPlan[] {
  const out: GraphPlan[] = [];
  const visit = (g: GraphIR, symbol: string, isRoot: boolean): void => {
    compileEdges(g); // shape gate only — rows are ADK-specific and discarded
    if (!isRoot && g.nodes.some((n) => n.type === "humanInput")) {
      throw new CodegenError(
        `nested workflow "${g.name}" contains a humanInput node — interrupts ` +
          `inside an invoked subgraph are not supported by the langgraph target yet`,
      );
    }
    for (const n of g.nodes) {
      if (n.type === "workflow") visit(n.config.graph, n.name, false);
    }
    out.push(planGraph(g, symbol, isRoot));
  };
  visit(ir, "root_agent", true);
  return out;
}

/** All user schemas across nesting levels, plus `<N>_CriticOutput` per loop node. */
function walkLgSchemas(ir: GraphIR): SchemaDef[] {
  const out: SchemaDef[] = [];
  const visit = (g: GraphIR): void => {
    for (const s of g.schemas) out.push(s);
    for (const n of g.nodes) {
      if (n.type === "workflow") visit(n.config.graph);
      else if (n.type === "loop") out.push(...lgLoopSchemas(n));
    }
  };
  visit(ir);
  return out;
}

/** Compile an IR into the runnable LangGraph project file set. */
export function generateLangGraphProject(ir: GraphIR): GeneratedProject {
  const plans = collectGraphPlans(ir);
  const allNodes = walkAllNodes(ir);
  const allSchemaDefs = walkLgSchemas(ir);
  const schemas = indexSchemas({ ...ir, schemas: allSchemaDefs });

  // Name guards: state classes must not collide with each other or with a
  // declared schema (everything shares the flat global namespace, ADR-0017).
  const classNames = new Set<string>();
  for (const plan of plans) {
    if (classNames.has(plan.stateClass) || schemas.has(plan.stateClass)) {
      throw new CodegenError(
        `state class "${plan.stateClass}" collides with another state class ` +
          `or a declared schema — rename the workflow or the schema`,
      );
    }
    classNames.add(plan.stateClass);
  }

  // nodeId → its graph's plan, for per-node stateClass/input-key dispatch.
  const planOf = new Map<string, GraphPlan>();
  for (const plan of plans) {
    for (const node of plan.graph.nodes) planOf.set(node.id, plan);
  }

  const loops = allNodes.filter((n): n is LoopNode => n.type === "loop");
  const hasHumanInput = allNodes.some((n) => n.type === "humanInput");

  const files: GeneratedProject = new Map();
  files.set("state.py", stateModule(ir, plans, schemas));
  files.set("schemas.py", schemasModule(ir, allSchemaDefs, schemas));
  files.set("nodes.py", nodesModule(ir, allNodes, planOf, schemas));
  files.set("agents.py", agentsModule(ir, allNodes, planOf, schemas));
  if (loops.length > 0) {
    files.set("loops.py", loopsModule(ir, loops, planOf, schemas));
  }
  files.set("graph.py", graphModule(ir, plans, planOf, hasHumanInput));
  files.set("main.py", mainModule(ir, hasHumanInput));
  files.set("test_graph.py", testModule(ir, plans));
  files.set("requirements.txt", REQUIREMENTS);
  files.set(".env.example", ENV_EXAMPLE);
  files.set("README.md", readme(ir, loops.length > 0, hasHumanInput));
  return files;
}

/** A node's resolved input key, or loud failure (joins never ask). */
function inputKey(plan: GraphPlan, node: GraphNode): string {
  const key = plan.inputKeyOf.get(node.id);
  if (!key) throw new CodegenError(`node "${node.name}" has no resolved input key`);
  return key;
}

function inputRef(plan: GraphPlan, node: GraphNode): string {
  return plan.keyRefOf.get(inputKey(plan, node)) ?? "str";
}

function stateModule(
  ir: GraphIR,
  plans: readonly GraphPlan[],
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Graph state — one key per node output (ADR-0046)", ir);
  const frags = plans.map((plan) => renderStateClass(plan, schemas));
  return joinModule(
    head,
    frags.flatMap((f) => f.imports),
    frags.map((f) => f.code),
    "def",
    LG_LOCAL,
  );
}

function schemasModule(
  ir: GraphIR,
  schemaDefs: readonly SchemaDef[],
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Pydantic schemas", ir);
  if (schemaDefs.length === 0) {
    return `${head}\n\n# No schemas declared in the IR.\n`;
  }
  const ordered = topologicalSchemas(schemaDefs);
  const frags = ordered.map((s) => renderSchema(s, schemas));
  return joinModule(
    head,
    frags.flatMap((f) => f.imports),
    frags.map((f) => f.code),
    "def",
    LG_LOCAL,
  );
}

function nodesModule(
  ir: GraphIR,
  allNodes: readonly GraphNode[],
  planOf: ReadonlyMap<string, GraphPlan>,
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Node functions (implement the TODO stubs)", ir);
  const frags: Fragment[] = [];
  for (const node of allNodes) {
    const plan = planOf.get(node.id)!;
    switch (node.type) {
      case "function":
      case "tool":
        frags.push(renderLgStub(node, inputKey(plan, node), plan.stateClass, schemas));
        break;
      case "router":
        frags.push(renderLgRouter(node, inputKey(plan, node), plan.stateClass, schemas));
        break;
      case "humanInput":
        frags.push(renderLgHumanInput(node, plan.stateClass, schemas));
        break;
      case "join":
        frags.push(
          renderLgJoin(node, plan.joinUpstreams.get(node.id) ?? [], plan.stateClass),
        );
        break;
      case "agent":
      case "workflow":
      case "loop":
        break;
      default: {
        const exhaustive: never = node;
        throw new CodegenError(
          `node of unknown type "${(exhaustive as GraphNode).type}"`,
        );
      }
    }
  }
  if (frags.length === 0) {
    return `${head}\n\n# No function, router, humanInput, tool, or join nodes in the IR.\n`;
  }
  return joinModule(
    head,
    frags.flatMap((f) => f.imports),
    frags.map((f) => f.code),
    "def",
    LG_LOCAL,
  );
}

function agentsModule(
  ir: GraphIR,
  allNodes: readonly GraphNode[],
  planOf: ReadonlyMap<string, GraphPlan>,
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Agent node functions", ir);
  const agents = allNodes.filter((n): n is AgentNode => n.type === "agent");
  if (agents.length === 0) return `${head}\n\n# No agent nodes in the IR.\n`;
  const frags = agents.map((node) => {
    const plan = planOf.get(node.id)!;
    return renderLgAgent(
      node,
      inputKey(plan, node),
      inputRef(plan, node),
      plan.stateClass,
      schemas,
    );
  });
  return joinModule(
    head,
    frags.flatMap((f) => f.imports),
    frags.map((f) => f.code),
    "def",
    LG_LOCAL,
  );
}

function loopsModule(
  ir: GraphIR,
  loops: readonly LoopNode[],
  planOf: ReadonlyMap<string, GraphPlan>,
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Loop node functions (encapsulated generate→critic→revise)", ir);
  const imports: ImportReq[] = [];
  const bodies: Body[] = [];
  for (const node of loops) {
    const plan = planOf.get(node.id)!;
    const constants = renderLgLoopConstants(node);
    const fn = renderLgLoop(
      node,
      inputKey(plan, node),
      inputRef(plan, node),
      plan.stateClass,
      schemas,
    );
    imports.push(...constants.imports, ...fn.imports);
    bodies.push({ code: constants.code, kind: "stmt" }, { code: fn.code, kind: "def" });
  }
  return stitchModule(head, imports, bodies);
}

/** One module body plus black's blank-line class for it (def → two blank lines). */
interface Body {
  readonly code: string;
  readonly kind: "def" | "stmt";
}

/**
 * Stitch a module whose bodies mix plain statements and `def`s: two blank
 * lines on any def boundary, one elsewhere (black's blank-line policy) —
 * the mixed-kind generalization of the shared `joinModule`.
 */
function stitchModule(head: string, imports: readonly ImportReq[], bodies: readonly Body[]): string {
  const importBlock = renderImports(imports, LG_LOCAL);
  let out = importBlock ? `${head}\n\n${importBlock}` : head;
  let prevKind: "def" | "stmt" = "stmt";
  for (const body of bodies) {
    const gap = body.kind === "def" || prevKind === "def" ? "\n\n\n" : "\n\n";
    out += gap + body.code.replace(/\n+$/, "");
    prevKind = body.kind;
  }
  return `${out}\n`;
}

/**
 * graph.py mixes plain wiring statements with subgraph-wrapper defs, so it
 * stitches its own bodies: two blank lines around any `def`, one elsewhere
 * (black's blank-line policy).
 */
function graphModule(
  ir: GraphIR,
  plans: readonly GraphPlan[],
  planOf: ReadonlyMap<string, GraphPlan>,
  hasHumanInput: boolean,
): string {
  const head = header("Workflow graph (entry module)", ir);
  const imports: ImportReq[] = [];
  const bodies: Body[] = [];

  const subPlanBySymbol = new Map<string, GraphPlan>();
  for (const plan of plans) subPlanBySymbol.set(plan.symbol, plan);

  for (const plan of plans) {
    // Node functions live in their per-type modules; workflow wrappers are
    // defined in this module by the sub-plan emitted just before the parent.
    for (const node of plan.graph.nodes) {
      if (node.type === "agent") imports.push({ module: "agents", names: [node.name] });
      else if (node.type === "loop") imports.push({ module: "loops", names: [node.name] });
      else if (node.type !== "workflow") {
        imports.push({ module: "nodes", names: [node.name] });
      }
    }
    const wiring = renderGraphWiring(plan, plan.isRoot && hasHumanInput);
    imports.push(...wiring.imports);
    bodies.push({ code: wiring.code, kind: "stmt" });
    if (!plan.isRoot) {
      const node = findWorkflowNode(ir, plan.symbol);
      const parentPlan = planOf.get(node.id)!;
      const wrapper = renderSubgraphWrapper(node, parentPlan, plan);
      imports.push(...wrapper.imports);
      bodies.push({ code: wrapper.code, kind: "def" });
    }
  }

  return stitchModule(head, imports, bodies);
}

/** The workflow node whose sub-graph a nested plan was built from. */
function findWorkflowNode(ir: GraphIR, symbol: string): WorkflowNode {
  const node = walkAllNodes(ir).find(
    (n): n is WorkflowNode => n.type === "workflow" && n.name === symbol,
  );
  if (!node) throw new CodegenError(`no workflow node named "${symbol}"`);
  return node;
}

/**
 * `main.py` — run the graph once with a sample input. Projects with a
 * humanInput node drive the documented interrupt/resume loop: invoke, print
 * the interrupt message, resume with `Command(resume=...)` on the same
 * thread_id (ADR-0046; runtime behavior verified by hand per ADR-0021 posture).
 */
function mainModule(ir: GraphIR, hasHumanInput: boolean): string {
  const head = header("Run the workflow once", ir);
  if (!hasHumanInput) {
    return `${head}

from graph import graph

# TODO: replace with a real input for this workflow.
SAMPLE_INPUT = "Hello — replace with a real input for this workflow."


def main() -> None:
    result = graph.invoke({${pyStr(WORKFLOW_INPUT)}: SAMPLE_INPUT})
    print("Final state:", result)


if __name__ == "__main__":
    main()
`;
  }
  return `${head}

from uuid import uuid4

from langgraph.types import Command

from graph import graph

# TODO: replace with a real input for this workflow.
SAMPLE_INPUT = "Hello — replace with a real input for this workflow."


def main() -> None:
    config = {"configurable": {"thread_id": f"run-{uuid4().hex[:8]}"}}
    result = graph.invoke({${pyStr(WORKFLOW_INPUT)}: SAMPLE_INPUT}, config)
    while "__interrupt__" in result:
        print(result["__interrupt__"][0].value["message"])
        result = graph.invoke(Command(resume=input("> ")), config)
    print("Final state:", result)


if __name__ == "__main__":
    main()
`;
}

/**
 * `test_graph.py` — free local dry-run (ADR-0041 posture): importing `graph`
 * builds and **compiles** every StateGraph, which is where LangGraph validates
 * node-name/edge consistency. Models are constructed lazily inside node
 * functions, so no API key is touched; the setdefault is belt-and-braces.
 */
function testModule(ir: GraphIR, plans: readonly GraphPlan[]): string {
  const head = header("Pytest dry-run (no API key needed)", ir);
  const root = plans[plans.length - 1]!;
  const entryEdge = root.graph.edges.find((e) => e.from === "START")!;
  const entryName = root.graph.nodes.find((n) => n.id === entryEdge.to)!.name;
  return `${head}
"""Free local dry-run — builds and compiles the StateGraph, calls no model API."""

import os

# Must precede the graph import: models are constructed lazily inside node
# functions, so no key is needed — this is belt-and-braces.
os.environ.setdefault("GOOGLE_API_KEY", "test-key")

from graph import graph


def test_graph_builds() -> None:
    assert ${pyStr(entryName)} in graph.get_graph().nodes
`;
}

function readme(ir: GraphIR, hasLoops: boolean, hasHumanInput: boolean): string {
  const description = ir.description ? `${ir.description}\n\n` : "";
  const loopsRow = hasLoops
    ? "| `loops.py` | One node function per loop node (generate→critic→revise until approved). |\n"
    : "";
  const interruptNote = hasHumanInput
    ? `
Human-input nodes pause the graph via \`interrupt()\`; \`main.py\` resumes it
with your console answer (\`Command(resume=...)\` on the same thread id). A
response schema, when declared, is validated in the node after resume.
`
    : "";
  return `# ${ir.name}

${description}Generated by **graphical-agents** from the Graph IR — a runnable **LangGraph**
(Python ≥3.10, langgraph 1.x) project.

Data flows through the shared graph state: every node writes its single output
to its own \`<node>_output\` key, and the entry input arrives as
\`${WORKFLOW_INPUT}\` (see \`state.py\`).

## Layout

| File | Contents |
| --- | --- |
| \`state.py\` | One \`TypedDict\` state class per graph — one key per node output. |
| \`schemas.py\` | Pydantic models for every IR schema. |
| \`nodes.py\` | Function / router / humanInput / tool / join node functions. **Implement the \`TODO\` stubs.** |
| \`agents.py\` | One node function per agent node (\`init_chat_model\` + typed output). |
${loopsRow}| \`graph.py\` | \`StateGraph\` wiring — \`graph\` is the compiled entry point. |
| \`main.py\` | Runs the graph once with \`SAMPLE_INPUT\`. |
| \`test_graph.py\` | Pytest dry-run — builds and compiles the graph, calls no model API. |

## Run

1. \`pip install -r requirements.txt\`
2. Copy \`.env.example\` to \`.env\` and fill in your credentials.
3. Implement the \`TODO\` stubs in \`nodes.py\`.
4. \`pytest\` — free dry-run that verifies the graph builds and compiles (no API key needed).
5. Edit \`SAMPLE_INPUT\` in \`main.py\`, then \`python main.py\` to run the workflow once.
${interruptNote}`;
}
