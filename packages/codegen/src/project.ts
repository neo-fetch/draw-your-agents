/**
 * Project assembler — GraphIR → a runnable ADK project file set (ARCHITECTURE.md
 * §5). This is the orchestrator of the codegen pipeline: it runs the edges
 * compiler, dispatches per-node template fragments (ADR-0003), dedupes their
 * imports, and assembles the modules + scaffold files.
 *
 * Scope: every declarative v1 node type. compileEdges rejects out-of-slice
 * graph *shapes* loud; this module additionally rejects out-of-slice node
 * *types* (currently just `tool`) loud. `black` is the post-process formatter
 * and is not run yet — fragments emit black-shaped text so that step is a
 * near no-op.
 *
 * Nested `workflow` nodes (ADR-0018) compile recursively: each sub-graph is its
 * own `Workflow(...)` assignment in `workflow.py`, emitted deepest-first so a
 * nested Workflow is bound before any parent Workflow references it. Per the
 * flat global namespace ([ADR-0017](../../../docs/DECISIONS.md)), every level's
 * agents / functions / routers / humanInputs / schemas flow into the shared
 * flat modules with no qualification.
 */
import type {
  AgentNode,
  FunctionNode,
  GraphIR,
  GraphNode,
  HumanInputNode,
  JoinNode,
  RouterNode,
  SchemaDef,
} from "@graphical-agents/ir";
import { compileEdges, renderEdgeRows, type EdgeRow } from "./edges.ts";
import {
  indexSchemas,
  renderAgent,
  renderFunction,
  renderHumanInput,
  renderJoin,
  renderRouter,
  renderSchema,
  type Fragment,
} from "./fragments.ts";
import { CodegenError, type ImportReq, indent, pyStr, renderImports } from "./python.ts";

/** A generated project: file path (relative to the project root) → file content. */
export type GeneratedProject = Map<string, string>;

const REQUIREMENTS = "google-adk==2.0.0\n";

const ENV_EXAMPLE = `# Google ADK credentials — copy this file to .env and fill in your key.
GOOGLE_API_KEY=
`;

/**
 * One graph context produced by the recursive walk: the root, plus one entry
 * per nested `workflow` node. Entries are emitted **deepest-first** so a
 * nested Workflow assignment is bound before any parent Workflow references it.
 */
interface WorkflowContext {
  readonly graph: GraphIR;
  readonly isRoot: boolean;
  /** Workflow symbol — `root_agent` for the root, otherwise the workflow node's name. */
  readonly symbol: string;
  readonly rows: readonly EdgeRow[];
  readonly joins: readonly JoinNode[];
}

/**
 * Depth-first preorder walk through every node across the parent + nested
 * sub-graphs (descending at each `workflow` node into its `config.graph`).
 */
function walkAllNodes(ir: GraphIR): GraphNode[] {
  const out: GraphNode[] = [];
  const visit = (g: GraphIR): void => {
    for (const n of g.nodes) {
      out.push(n);
      if (n.type === "workflow") visit(n.config.graph);
    }
  };
  visit(ir);
  return out;
}

/** Same walk, but yielding the schema declarations of every level. */
function walkAllSchemas(ir: GraphIR): SchemaDef[] {
  const out: SchemaDef[] = [];
  const visit = (g: GraphIR): void => {
    for (const s of g.schemas) out.push(s);
    for (const n of g.nodes) if (n.type === "workflow") visit(n.config.graph);
  };
  visit(ir);
  return out;
}

/**
 * Collect one WorkflowContext per graph (root + each nested), in **deepest-first**
 * post-order so emission satisfies "declared before referenced" automatically.
 */
function collectWorkflowContexts(ir: GraphIR): WorkflowContext[] {
  const out: WorkflowContext[] = [];
  const visit = (g: GraphIR, symbol: string, isRoot: boolean): void => {
    for (const n of g.nodes) {
      if (n.type === "workflow") visit(n.config.graph, n.name, false);
    }
    out.push({
      graph: g,
      isRoot,
      symbol,
      rows: compileEdges(g),
      joins: g.nodes.filter((n): n is JoinNode => n.type === "join"),
    });
  };
  visit(ir, "root_agent", true);
  return out;
}

/** Compile an IR into the runnable ADK project file set. */
export function generateProject(ir: GraphIR): GeneratedProject {
  // Flatten across nesting levels (ADR-0017 flat global namespace). Walk order
  // is DFS preorder so module bodies read naturally — parent's nodes, then the
  // sub-graph's nodes at the point of the workflow node, then the rest.
  const allNodes = walkAllNodes(ir);
  const allSchemaDefs = walkAllSchemas(ir);

  // Reject out-of-slice node types loud. `tool` is the only remaining
  // Phase 3 type after [ADR-0018](../../../docs/DECISIONS.md).
  for (const node of allNodes) {
    if (
      node.type !== "agent" &&
      node.type !== "function" &&
      node.type !== "router" &&
      node.type !== "join" &&
      node.type !== "humanInput" &&
      node.type !== "workflow"
    ) {
      throw new CodegenError(
        `node "${node.name}" of type "${node.type}" is not handled by the v1 ` +
          "agent+function+router+join+humanInput+workflow slice",
      );
    }
  }

  const schemas = indexSchemas({ ...ir, schemas: allSchemaDefs });
  const agents = allNodes.filter((n): n is AgentNode => n.type === "agent");
  const functions = allNodes.filter((n): n is FunctionNode => n.type === "function");
  const routers = allNodes.filter((n): n is RouterNode => n.type === "router");
  const humanInputs = allNodes.filter((n): n is HumanInputNode => n.type === "humanInput");
  // Workflow assignments + their joins are emitted by workflowModule via the
  // context list; deepest-first dependency order is baked into the collector.
  const workflowContexts = collectWorkflowContexts(ir);

  const files: GeneratedProject = new Map();
  files.set("schemas.py", schemasModule(ir, allSchemaDefs, schemas));
  files.set(
    "functions.py",
    functionsModule(ir, allNodes, functions, routers, humanInputs, schemas),
  );
  files.set("agents.py", agentsModule(ir, agents, schemas));
  files.set("workflow.py", workflowModule(ir, workflowContexts, agents, functions, routers, humanInputs));
  files.set("requirements.txt", REQUIREMENTS);
  files.set(".env.example", ENV_EXAMPLE);
  files.set("README.md", readme(ir));
  return files;
}

function header(title: string, ir: GraphIR): string {
  return `# ${title} — generated by graphical-agents from the Graph IR (${ir.name}).`;
}

/**
 * Stitch a header, deduped imports, and bodies into one module. `kind` controls
 * black's blank-line policy: two blank lines around top-level `def`/`class`,
 * one around plain assignments.
 */
function joinModule(
  head: string,
  imports: readonly ImportReq[],
  bodies: readonly string[],
  kind: "def" | "stmt",
): string {
  const importBlock = renderImports(imports);
  const gap = kind === "def" ? "\n\n\n" : "\n\n";
  const body = bodies.map((b) => b.replace(/\n+$/, "")).join(gap);
  const prefix = importBlock ? `${head}\n\n${importBlock}` : head;
  if (bodies.length === 0) return `${prefix}\n`;
  return `${prefix}${gap}${body}\n`;
}

function schemasModule(
  ir: GraphIR,
  schemaDefs: readonly SchemaDef[],
  _schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Pydantic schemas", ir);
  if (schemaDefs.length === 0) {
    return `${head}\n\n# No schemas declared in the IR.\n`;
  }
  const frags = schemaDefs.map(renderSchema);
  return joinModule(head, frags.flatMap((f) => f.imports), frags.map((f) => f.code), "def");
}

function functionsModule(
  ir: GraphIR,
  allNodes: readonly GraphNode[],
  functions: readonly FunctionNode[],
  routers: readonly RouterNode[],
  humanInputs: readonly HumanInputNode[],
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Function bodies (implement the TODO stubs)", ir);
  if (functions.length === 0 && routers.length === 0 && humanInputs.length === 0) {
    return `${head}\n\n# No function, router, or humanInput nodes in the IR.\n`;
  }
  // Render in DFS preorder across the parent + every nested sub-graph so
  // function, router, and humanInput defs interleave naturally (ADR-0017).
  const byId = new Set<string>(
    [...functions, ...routers, ...humanInputs].map((n) => n.id),
  );
  const frags: Fragment[] = allNodes
    .filter((n) => byId.has(n.id))
    .map((n) => {
      switch (n.type) {
        case "router":
          return renderRouter(n as RouterNode, schemas);
        case "humanInput":
          return renderHumanInput(n as HumanInputNode, schemas);
        default:
          return renderFunction(n as FunctionNode, schemas);
      }
    });
  return joinModule(head, frags.flatMap((f) => f.imports), frags.map((f) => f.code), "def");
}

function agentsModule(
  ir: GraphIR,
  agents: readonly AgentNode[],
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Agents", ir);
  if (agents.length === 0) return `${head}\n\n# No agent nodes in the IR.\n`;
  const frags: Fragment[] = agents.map((n) => renderAgent(n, schemas));
  return joinModule(head, frags.flatMap((f) => f.imports), frags.map((f) => f.code), "stmt");
}

function workflowModule(
  ir: GraphIR,
  contexts: readonly WorkflowContext[],
  agents: readonly AgentNode[],
  functions: readonly FunctionNode[],
  routers: readonly RouterNode[],
  humanInputs: readonly HumanInputNode[],
): string {
  const head = header("Workflow graph (entry module)", ir);
  const imports: ImportReq[] = [{ module: "google.adk", names: ["Workflow"] }];
  if (agents.length > 0) imports.push({ module: "agents", names: agents.map((a) => a.name) });
  // Routers and humanInput generators live in functions.py too — their symbols
  // appear in the edge rows alongside plain function nodes.
  const fnNames = [
    ...functions.map((f) => f.name),
    ...routers.map((r) => r.name),
    ...humanInputs.map((h) => h.name),
  ];
  if (fnNames.length > 0) imports.push({ module: "functions", names: fnNames });

  // Walk contexts deepest-first: emit each level's join declarations inline,
  // then this level's `Workflow(...)` assignment. The root context comes last
  // and renders as `root_agent = Workflow(...)`; every nested context renders
  // as `<workflow_node_name> = Workflow(...)` so the parent's edge rows can
  // reference the symbol by name (ADR-0018).
  const bodies: string[] = [];
  for (const ctx of contexts) {
    for (const join of ctx.joins) {
      const frag = renderJoin(join);
      imports.push(...frag.imports);
      bodies.push(frag.code);
    }
    const kwargs = `name=${pyStr(ctx.graph.name)},\n${renderEdgeRows(ctx.rows)},`;
    bodies.push(`${ctx.symbol} = Workflow(\n${indent(kwargs)}\n)\n`);
  }

  return joinModule(head, imports, bodies, "stmt");
}

function readme(ir: GraphIR): string {
  const description = ir.description ? `${ir.description}\n\n` : "";
  return `# ${ir.name}

${description}Generated by **graphical-agents** from the Graph IR — a runnable Google ADK
(graph-workflow, v2.0.0) project.

## Layout

| File | Contents |
| --- | --- |
| \`schemas.py\` | Pydantic models for every IR schema. |
| \`functions.py\` | One function per function node. **Implement the \`TODO\` stubs.** |
| \`agents.py\` | One \`Agent\` per agent node. |
| \`workflow.py\` | \`root_agent = Workflow(edges=[...])\` — the graph entry point. |

## Run

1. \`pip install -r requirements.txt\`
2. Copy \`.env.example\` to \`.env\` and fill in your credentials.
3. Implement the \`TODO\` stubs in \`functions.py\`.
4. Run with the ADK runtime (e.g. \`adk run workflow.py\`).
`;
}
