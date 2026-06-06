/**
 * Project assembler — GraphIR → a runnable ADK project file set (ARCHITECTURE.md
 * §5). This is the orchestrator of the codegen pipeline: it runs the edges
 * compiler, dispatches per-node template fragments (ADR-0003), dedupes their
 * imports, and assembles the modules + scaffold files.
 *
 * Scope: every declarative v1 node type — agent, function, router, join,
 * humanInput, workflow, and tool (ADR-0019, the closing slice). compileEdges
 * rejects out-of-slice graph *shapes* loud; this module's type guard now only
 * fires on malformed IR with an unknown `type` string (the validator should
 * have caught it upstream). `black` is the post-process formatter and is not
 * run yet — fragments emit black-shaped text so that step is a near no-op.
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
  ToolNode,
} from "@graphical-agents/ir";
import { compileEdges, renderEdgeRows, type EdgeRow, type RowMember } from "./edges.ts";
import {
  indexSchemas,
  renderAgent,
  renderFunction,
  renderHumanInput,
  renderJoin,
  renderRouter,
  renderSchema,
  renderToolImpl,
  renderToolWrapper,
  toolImplName,
  type Fragment,
} from "./fragments.ts";
import {
  BLACK_LINE_WIDTH,
  CodegenError,
  type ImportReq,
  pyStr,
  renderImports,
} from "./python.ts";

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
  readonly tools: readonly ToolNode[];
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
      tools: g.nodes.filter((n): n is ToolNode => n.type === "tool"),
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

  // Reject unknown node types loud. After ADR-0019, every v1 declarative type
  // (agent/function/router/join/humanInput/workflow/tool) is handled — so any
  // miss here is a malformed IR the validator should have caught upstream.
  for (const node of allNodes) {
    if (
      node.type !== "agent" &&
      node.type !== "function" &&
      node.type !== "router" &&
      node.type !== "join" &&
      node.type !== "humanInput" &&
      node.type !== "workflow" &&
      node.type !== "tool"
    ) {
      throw new CodegenError(
        `node "${(node as { name: string }).name}" of unknown type ` +
          `"${(node as { type: string }).type}"`,
      );
    }
  }

  const schemas = indexSchemas({ ...ir, schemas: allSchemaDefs });
  const agents = allNodes.filter((n): n is AgentNode => n.type === "agent");
  const functions = allNodes.filter((n): n is FunctionNode => n.type === "function");
  const routers = allNodes.filter((n): n is RouterNode => n.type === "router");
  const humanInputs = allNodes.filter((n): n is HumanInputNode => n.type === "humanInput");
  const tools = allNodes.filter((n): n is ToolNode => n.type === "tool");
  // Workflow assignments + their joins + their tool wrappers are emitted by
  // workflowModule via the context list; deepest-first dependency order is
  // baked into the collector.
  const workflowContexts = collectWorkflowContexts(ir);

  const files: GeneratedProject = new Map();
  files.set("schemas.py", schemasModule(ir, allSchemaDefs, schemas));
  files.set(
    "functions.py",
    functionsModule(ir, allNodes, functions, routers, humanInputs, tools, schemas),
  );
  files.set("agents.py", agentsModule(ir, agents, schemas));
  files.set(
    "workflow.py",
    workflowModule(ir, workflowContexts, agents, functions, routers, humanInputs, tools),
  );
  files.set("requirements.txt", REQUIREMENTS);
  files.set(".env.example", ENV_EXAMPLE);
  files.set("README.md", readme(ir));
  return files;
}

function header(title: string, ir: GraphIR): string {
  return `# ${title} — generated by graphical-agents from the Graph IR (${ir.name}).`;
}

const sp = (n: number): string => " ".repeat(n);

function renderMemberInline(m: RowMember): string {
  switch (m.kind) {
    case "start":
      return `"START"`;
    case "node":
      return m.name;
    case "routeMap":
      return `{${m.entries.map((e) => `"${e.route}": ${e.target}`).join(", ")}}`;
  }
}

/** Render one row member, wrapping a route-map dict if it would overflow at `col`. */
function renderMemberAt(m: RowMember, col: number): string {
  const inline = renderMemberInline(m);
  if (m.kind !== "routeMap" || col + inline.length + 1 <= BLACK_LINE_WIDTH) return inline;
  const inner = m.entries
    .map((e) => `${sp(col + 4)}"${e.route}": ${e.target},`)
    .join("\n");
  return `{\n${inner}\n${sp(col)}}`;
}

/** Render one row (tuple), inline if it fits at `col`, else wrapped. */
function renderRowAt(row: EdgeRow, col: number): string {
  const inline = `(${row.map(renderMemberInline).join(", ")})`;
  if (col + inline.length + 1 <= BLACK_LINE_WIDTH) return inline;
  const memberLines = row.map((m) => renderMemberAt(m, col + 4));
  const inner = memberLines.map((s) => `${sp(col + 4)}${s},`).join("\n");
  return `(\n${inner}\n${sp(col)})`;
}

/**
 * Black-shaped renderer for the `edges=[...]` block inside a `Workflow(...)`
 * call. Compact single-line form when it fits at column `col`; otherwise
 * multi-line with one row per line and recursively wrapped sub-elements —
 * matching black's idempotent output (ADR-0020).
 *
 * `renderEdgeRows` (ADR-0010) stays the compact canonical form used by the
 * edges-compiler goldens; this helper is the workflow.py assembler's
 * line-wrapper.
 */
export function renderEdgesBlock(rows: readonly EdgeRow[], col: number): string {
  const compact = renderEdgeRows(rows);
  if (col + compact.length + 1 <= BLACK_LINE_WIDTH) return compact;
  const rowLines = rows.map((r) => renderRowAt(r, col + 4));
  const inner = rowLines.map((s) => `${sp(col + 4)}${s},`).join("\n");
  return `edges=[\n${inner}\n${sp(col)}]`;
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

/**
 * Topologically sort schemas so a nested-schema field's class is declared
 * before any schema that references it (ADR-0037). The validator has already
 * rejected cycles via `SCHEMA_FIELD_CYCLE`; this is a post-order DFS with a
 * stable secondary order — non-dependency siblings keep their original array
 * order, so the golden output is deterministic.
 */
function topologicalSchemas(
  schemaDefs: readonly SchemaDef[],
): readonly SchemaDef[] {
  const byName = new Map<string, SchemaDef>();
  for (const s of schemaDefs) byName.set(s.name, s);
  const out: SchemaDef[] = [];
  const seen = new Set<string>();
  const visit = (s: SchemaDef): void => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    for (const f of s.fields) {
      const dep = byName.get(f.type);
      if (dep) visit(dep);
    }
    out.push(s);
  };
  for (const s of schemaDefs) visit(s);
  return out;
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
  return joinModule(head, frags.flatMap((f) => f.imports), frags.map((f) => f.code), "def");
}

function functionsModule(
  ir: GraphIR,
  allNodes: readonly GraphNode[],
  functions: readonly FunctionNode[],
  routers: readonly RouterNode[],
  humanInputs: readonly HumanInputNode[],
  tools: readonly ToolNode[],
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Function bodies (implement the TODO stubs)", ir);
  if (
    functions.length === 0 &&
    routers.length === 0 &&
    humanInputs.length === 0 &&
    tools.length === 0
  ) {
    return `${head}\n\n# No function, router, humanInput, or tool nodes in the IR.\n`;
  }
  // Render in DFS preorder across the parent + every nested sub-graph so
  // function, router, humanInput, and tool-impl defs interleave naturally
  // (ADR-0017).
  const byId = new Set<string>(
    [...functions, ...routers, ...humanInputs, ...tools].map((n) => n.id),
  );
  const frags: Fragment[] = allNodes
    .filter((n) => byId.has(n.id))
    .map((n) => {
      switch (n.type) {
        case "router":
          return renderRouter(n as RouterNode, schemas);
        case "humanInput":
          return renderHumanInput(n as HumanInputNode, schemas);
        case "tool":
          return renderToolImpl(n as ToolNode, schemas);
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
  tools: readonly ToolNode[],
): string {
  const head = header("Workflow graph (entry module)", ir);
  const imports: ImportReq[] = [{ module: "google.adk", names: ["Workflow"] }];
  if (agents.length > 0) imports.push({ module: "agents", names: agents.map((a) => a.name) });
  // Routers and humanInput generators live in functions.py too — their symbols
  // appear in the edge rows alongside plain function nodes. Tool impls live
  // in functions.py as `<name>_impl`; the FunctionTool wrapper (which is what
  // the edge rows reference) is declared inline below.
  const fnNames = [
    ...functions.map((f) => f.name),
    ...routers.map((r) => r.name),
    ...humanInputs.map((h) => h.name),
    ...tools.map((t) => toolImplName(t)),
  ];
  if (fnNames.length > 0) imports.push({ module: "functions", names: fnNames });

  // Walk contexts deepest-first: emit each level's tool wrappers, then its
  // join declarations, then this level's `Workflow(...)` assignment. The root
  // context comes last and renders as `root_agent = Workflow(...)`; every
  // nested context renders as `<workflow_node_name> = Workflow(...)` so the
  // parent's edge rows can reference the symbol by name (ADR-0018 / ADR-0019).
  const bodies: string[] = [];
  for (const ctx of contexts) {
    for (const tool of ctx.tools) {
      const frag = renderToolWrapper(tool);
      imports.push(...frag.imports);
      bodies.push(frag.code);
    }
    for (const join of ctx.joins) {
      const frag = renderJoin(join);
      imports.push(...frag.imports);
      bodies.push(frag.code);
    }
    const edgesBlock = renderEdgesBlock(ctx.rows, 4);
    bodies.push(
      `${ctx.symbol} = Workflow(\n` +
        `    name=${pyStr(ctx.graph.name)},\n` +
        `    ${edgesBlock},\n` +
        `)\n`,
    );
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
