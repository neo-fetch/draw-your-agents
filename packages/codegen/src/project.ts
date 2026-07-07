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
  LoopNode,
  RouterNode,
  SchemaDef,
  ToolNode,
} from "@graphical-agents/ir";
import { compileEdges, renderEdgeRows, type EdgeRow, type RowMember } from "./edges.ts";
import {
  indexSchemas,
  loopOrchestratorName,
  loopWrapperSchemas,
  renderAgent,
  renderFunction,
  renderHumanInput,
  renderJoin,
  renderLoopOrchestrator,
  renderRouter,
  renderSchema,
  renderTool,
  renderValidateNodeOutputHelper,
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

// `google-adk` stays exact-pinned (codegen targets that API surface);
// `pytest` floats — test_workflow.py uses only plain asserts (ADR-0041).
const REQUIREMENTS = "google-adk==2.0.0\npytest\n";

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
 * Shared with the LangGraph target (ADR-0045).
 */
export function walkAllNodes(ir: GraphIR): GraphNode[] {
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

/**
 * Same walk, but yielding the schema declarations of every level. Loop nodes
 * (ADR-0039) contribute four canonical wrapper schemas inline at the point
 * they appear — `<N>_GenInput`, `<N>_CriticInput`, `<N>_ReviserInput`,
 * `<N>_CriticOutput` — so the existing `topologicalSchemas` path emits them
 * after the user's `payloadType`/`inputType` schemas.
 */
function walkAllSchemas(ir: GraphIR): SchemaDef[] {
  const out: SchemaDef[] = [];
  const visit = (g: GraphIR): void => {
    for (const s of g.schemas) out.push(s);
    for (const n of g.nodes) {
      if (n.type === "workflow") visit(n.config.graph);
      else if (n.type === "loop") out.push(...loopWrapperSchemas(n));
    }
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

/**
 * Node ids that receive their `node_input` from a `JoinNode`, across every
 * nesting level (E2E finding F2). A join delivers a **dict of branch outputs**
 * keyed by upstream node name, so these nodes' functions must be annotated
 * `dict` — ADK 2.0 pydantic-coerces `node_input` against the annotation.
 */
function joinFedNodeIds(ir: GraphIR): ReadonlySet<string> {
  const out = new Set<string>();
  const visit = (g: GraphIR): void => {
    const joinIds = new Set(
      g.nodes.filter((n) => n.type === "join").map((n) => n.id),
    );
    for (const e of g.edges) {
      if (e.from !== "START" && joinIds.has(e.from)) out.add(e.to);
    }
    for (const n of g.nodes) {
      if (n.type === "workflow") visit(n.config.graph);
    }
  };
  visit(ir);
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
      node.type !== "tool" &&
      node.type !== "loop"
    ) {
      throw new CodegenError(
        `node "${(node as { name: string }).name}" of unknown type ` +
          `"${(node as { type: string }).type}"`,
      );
    }
  }

  const schemas = indexSchemas({ ...ir, schemas: allSchemaDefs });
  const joinFed = joinFedNodeIds(ir);
  const agents = allNodes.filter((n): n is AgentNode => n.type === "agent");
  const functions = allNodes.filter((n): n is FunctionNode => n.type === "function");
  const routers = allNodes.filter((n): n is RouterNode => n.type === "router");
  const humanInputs = allNodes.filter((n): n is HumanInputNode => n.type === "humanInput");
  const tools = allNodes.filter((n): n is ToolNode => n.type === "tool");
  const loops = allNodes.filter((n): n is LoopNode => n.type === "loop");
  // Workflow assignments + their joins + their tool wrappers are emitted by
  // workflowModule via the context list; deepest-first dependency order is
  // baked into the collector.
  const workflowContexts = collectWorkflowContexts(ir);

  const files: GeneratedProject = new Map();
  files.set("schemas.py", schemasModule(ir, allSchemaDefs, schemas));
  files.set(
    "functions.py",
    functionsModule(ir, allNodes, functions, routers, humanInputs, tools, schemas, joinFed),
  );
  files.set("agents.py", agentsModule(ir, agents, schemas));
  if (loops.length > 0) {
    files.set("loops.py", loopsModule(ir, loops, schemas));
  }
  files.set(
    "workflow.py",
    workflowModule(ir, workflowContexts, agents, functions, routers, humanInputs, tools, loops),
  );
  files.set("agent.py", agentShim(ir));
  files.set("main.py", mainModule(ir));
  files.set("test_workflow.py", testModule(ir));
  files.set("requirements.txt", REQUIREMENTS);
  files.set(".env.example", ENV_EXAMPLE);
  files.set("README.md", readme(ir, loops.length > 0));
  return files;
}

/** Module-top comment line. Shared with the LangGraph target (ADR-0045). */
export function header(title: string, ir: GraphIR): string {
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
 * one around plain assignments. Shared with the LangGraph target (ADR-0045),
 * which passes its own `localModules` set through to `renderImports`.
 */
export function joinModule(
  head: string,
  imports: readonly ImportReq[],
  bodies: readonly string[],
  kind: "def" | "stmt",
  localModules?: ReadonlySet<string>,
): string {
  const importBlock = renderImports(imports, localModules);
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
 * order, so the golden output is deterministic. Shared with the LangGraph
 * target (ADR-0045).
 */
export function topologicalSchemas(
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
  joinFed: ReadonlySet<string>,
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
          return renderRouter(n as RouterNode, schemas, joinFed.has(n.id));
        case "humanInput":
          return renderHumanInput(n as HumanInputNode, schemas);
        case "tool":
          return renderTool(n as ToolNode, schemas, joinFed.has(n.id));
        default:
          return renderFunction(n as FunctionNode, schemas, joinFed.has(n.id));
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
  loops: readonly LoopNode[],
): string {
  const head = header("Workflow graph (entry module)", ir);
  const imports: ImportReq[] = [{ module: "google.adk", names: ["Workflow"] }];
  if (agents.length > 0) imports.push({ module: "agents", names: agents.map((a) => a.name) });
  if (loops.length > 0) {
    imports.push({ module: "loops", names: loops.map((l) => loopOrchestratorName(l)) });
  }
  // Routers, humanInput generators, and tool functions live in functions.py
  // too — their symbols appear in the edge rows alongside plain function
  // nodes. (Tools used to get a `FunctionTool(func=<name>_impl)` wrapper here
  // per ADR-0019, but real ADK 2.0 treats a FunctionTool in an edge row as a
  // ToolNode expecting tool-call args, not the upstream Content — E2E finding
  // F3 — so a graph-positioned tool is now a plain function node.)
  const fnNames = [
    ...functions.map((f) => f.name),
    ...routers.map((r) => r.name),
    ...humanInputs.map((h) => h.name),
    ...tools.map((t) => t.name),
  ];
  if (fnNames.length > 0) imports.push({ module: "functions", names: fnNames });

  // Walk contexts deepest-first: emit each level's join declarations, then
  // this level's `Workflow(...)` assignment. The root context comes last and
  // renders as `root_agent = Workflow(...)`; every nested context renders as
  // `<workflow_node_name> = Workflow(...)` so the parent's edge rows can
  // reference the symbol by name (ADR-0018).
  const bodies: string[] = [];
  for (const ctx of contexts) {
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

/**
 * `loops.py` — the `@node` orchestrator for every `loop` IR node (ADR-0039),
 * plus the shared `validate_node_output` helper. Imported by `workflow.py`.
 */
function loopsModule(
  ir: GraphIR,
  loops: readonly LoopNode[],
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const head = header("Loop orchestrators (encapsulated dynamic workflow)", ir);
  const helper = renderValidateNodeOutputHelper();
  const frags: Fragment[] = [helper, ...loops.map((l) => renderLoopOrchestrator(l, schemas))];
  return joinModule(head, frags.flatMap((f) => f.imports), frags.map((f) => f.code), "def");
}

/**
 * `agent.py` — ADK CLI discovery shim (E2E finding F5): `adk run <project>` /
 * `adk web` load `root_agent` from the project folder's `agent.py` (or
 * `__init__.py` / `root_agent.yaml`) — never from `workflow.py`, where the
 * graph itself lives. One import line keeps workflow.py the single source of
 * the graph while making the generated folder CLI-runnable as shipped.
 */
function agentShim(ir: GraphIR): string {
  const head = header("ADK CLI entry shim (`adk run` / `adk web`)", ir);
  return `${head}

from workflow import root_agent

__all__ = ["root_agent"]
`;
}

/**
 * `main.py` — run the workflow once with a sample input (ADR-0041). Mirrors the
 * manually-verified Runner wrapper from `exploring/generic-workflow.py`
 * (ADR-0021 posture: runtime behavior is verified against real ADK 2.0.0 by
 * hand, not by `npm test` — the gate proves golden byte-match + `py_compile`).
 * The sample input is always plain text: data flow is positional and the entry
 * message is user-domain, so we never fabricate structured JSON from the entry
 * node's input schema.
 */
function mainModule(ir: GraphIR): string {
  const head = header("Run the workflow once", ir);
  return `${head}

import asyncio
from uuid import uuid4

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from workflow import root_agent

APP_NAME = ${pyStr(ir.name)}
USER_ID = "user"

# TODO: replace with a real input for this workflow.
SAMPLE_INPUT = "Hello — replace with a real input for this workflow."


async def main() -> None:
    session_service = InMemorySessionService()
    session_id = f"run-{uuid4().hex[:8]}"
    await session_service.create_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    )
    runner = Runner(
        agent=root_agent, app_name=APP_NAME, session_service=session_service
    )
    async for event in runner.run_async(
        user_id=USER_ID,
        session_id=session_id,
        new_message=types.Content(role="user", parts=[types.Part(text=SAMPLE_INPUT)]),
    ):
        print(event)
    final_session = await session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    )
    print("Final session state:", final_session.state if final_session else {})


if __name__ == "__main__":
    asyncio.run(main())
`;
}

/**
 * `test_workflow.py` — free local dry-run (ADR-0041): importing `workflow`
 * constructs the entire graph (every Agent, FunctionTool, Workflow) without
 * calling any model API. The `GOOGLE_API_KEY` setdefault must precede the
 * import so the dry-run needs no real key.
 */
function testModule(ir: GraphIR): string {
  const head = header("Pytest dry-run (no API key needed)", ir);
  return `${head}
"""Free local dry-run — constructs the full graph, calls no model API."""

import os

# Must precede the workflow import: agent construction needs *a* key, not a real one.
os.environ.setdefault("GOOGLE_API_KEY", "test-key")

from google.adk import Workflow

from workflow import root_agent


def test_root_agent_constructs() -> None:
    assert isinstance(root_agent, Workflow)
`;
}

function readme(ir: GraphIR, hasLoops: boolean): string {
  const description = ir.description ? `${ir.description}\n\n` : "";
  const loopsRow = hasLoops
    ? "| `loops.py` | One `@node` orchestrator per loop node (encapsulated `LlmAgent` loop). |\n"
    : "";
  return `# ${ir.name}

${description}Generated by **graphical-agents** from the Graph IR — a runnable Google ADK
(graph-workflow, v2.0.0) project.

## Layout

| File | Contents |
| --- | --- |
| \`schemas.py\` | Pydantic models for every IR schema. |
| \`functions.py\` | One function per function node. **Implement the \`TODO\` stubs.** |
| \`agents.py\` | One \`Agent\` per agent node. |
${loopsRow}| \`workflow.py\` | \`root_agent = Workflow(edges=[...])\` — the graph entry point. |
| \`agent.py\` | ADK CLI discovery shim — exposes \`root_agent\` for \`adk run\` / \`adk web\`. |
| \`main.py\` | Runs the workflow once with \`SAMPLE_INPUT\`. |
| \`test_workflow.py\` | Pytest dry-run — constructs the graph, calls no model API. |

## Run

1. \`pip install -r requirements.txt\`
2. Copy \`.env.example\` to \`.env\` and fill in your credentials.
3. Implement the \`TODO\` stubs in \`functions.py\`.
4. \`pytest\` — free dry-run that verifies the graph constructs (no API key needed).
5. Edit \`SAMPLE_INPUT\` in \`main.py\`, then \`python main.py\` to run the workflow once.

Alternatively, use the ADK CLI from the directory that **contains** this project
folder: \`adk run ${ir.name} "your input"\` (one-shot) or \`adk web .\` (browser UI).
Workflows containing human-input nodes pause for a response — prefer an interactive
ADK runtime for those.
`;
}
