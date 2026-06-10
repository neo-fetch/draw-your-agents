/**
 * Golden-file tests for the LangGraph project assembler (ADR-0045/0046) — the
 * mirror of [project.test.ts] for the second target. The golden fixtures under
 * golden-langgraph/ are the LangGraph codegen spec; the trust check shells out
 * to `python3 -m py_compile` on every generated `.py` (syntax only — it does
 * not import langgraph, same posture as the ADK suite).
 *
 * showcase-all-nodes has no golden (consistent with the ADK target) but must
 * generate and pass py_compile — it exercises every node type at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { generateLangGraphProject } from "../src/langgraph/project.ts";
import { CodegenError } from "../src/python.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function loadIR(relPath: string): GraphIR {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as GraphIR;
}

function loadGolden(project: string, file: string): string {
  return readFileSync(join(here, "golden-langgraph", project, file), "utf8");
}

function compileCheck(files: Map<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), "ga-codegen-lg-"));
  const pyFiles: string[] = [];
  for (const [file, content] of files) {
    const path = join(dir, file);
    writeFileSync(path, content);
    if (file.endsWith(".py")) pyFiles.push(path);
  }
  assert.ok(pyFiles.length > 0, "expected at least one .py file");
  // py_compile only — proves syntax, does not import langgraph.
  execFileSync("python3", ["-m", "py_compile", ...pyFiles], { stdio: "pipe" });
}

const BASE_FILES = [
  "state.py",
  "schemas.py",
  "nodes.py",
  "agents.py",
  "graph.py",
  "main.py",
  "test_graph.py",
  "requirements.txt",
  ".env.example",
  "README.md",
];

// Keep in sync with PROJECTS in project.test.ts / scripts/update-goldens.ts —
// the same fixtures back both targets' goldens (ADR-0045).
const PROJECTS = [
  { name: "city-time", fixture: "packages/ir/fixtures/city-time.ir.json", extras: [] },
  { name: "routing", fixture: "packages/ir/fixtures/routing.ir.json", extras: [] },
  { name: "parallel", fixture: "packages/ir/fixtures/parallel.ir.json", extras: [] },
  { name: "human-input", fixture: "packages/ir/fixtures/human-input.ir.json", extras: [] },
  { name: "nested", fixture: "packages/ir/fixtures/nested.ir.json", extras: [] },
  { name: "tool", fixture: "packages/ir/fixtures/tool.ir.json", extras: [] },
  { name: "nested-schema", fixture: "packages/ir/fixtures/nested-schema.ir.json", extras: [] },
  { name: "critic-loop", fixture: "packages/ir/fixtures/critic-loop.ir.json", extras: ["loops.py"] },
];

for (const { name, fixture, extras } of PROJECTS) {
  const expectedFiles = [...BASE_FILES, ...extras];
  test(`langgraph ${name}: generates exactly the ADR-0045 file set`, () => {
    const files = generateLangGraphProject(loadIR(fixture));
    assert.deepEqual([...files.keys()].sort(), [...expectedFiles].sort());
  });

  for (const file of expectedFiles) {
    test(`langgraph ${name}: ${file} matches golden`, () => {
      const files = generateLangGraphProject(loadIR(fixture));
      assert.equal(files.get(file), loadGolden(name, file));
    });
  }

  test(`langgraph ${name}: trust check — every generated .py passes py_compile`, () => {
    compileCheck(generateLangGraphProject(loadIR(fixture)));
  });
}

test("langgraph showcase-all-nodes: every node type generates and passes py_compile", () => {
  const files = generateLangGraphProject(
    loadIR("packages/ir/fixtures/showcase-all-nodes.ir.json"),
  );
  assert.ok(files.has("loops.py"), "showcase has a loop node");
  compileCheck(files);
});

test("langgraph rejects agent-attached tools loud", () => {
  const ir = loadIR("packages/ir/fixtures/tool.ir.json");
  const agent = ir.nodes.find((n) => n.type === "agent")!;
  (agent.config as { tools?: string[] }).tools = ["fetch_data"];
  assert.throws(() => generateLangGraphProject(ir), CodegenError);
});

test("langgraph rejects a non-null ADK-flavored body loud", () => {
  const ir = loadIR("packages/ir/fixtures/city-time.ir.json");
  const fn = ir.nodes.find((n) => n.type === "function")!;
  (fn.config as { body?: string | null }).body = "return Event(output=node_input)";
  assert.throws(() => generateLangGraphProject(ir), CodegenError);
});

test("langgraph rejects a humanInput inside a nested workflow loud", () => {
  const ir = loadIR("packages/ir/fixtures/nested.ir.json");
  const wf = ir.nodes.find((n) => n.type === "workflow")!;
  const sub = (wf.config as { graph: GraphIR }).graph;
  sub.nodes.push({
    id: "n_inner_ask",
    type: "humanInput",
    name: "inner_ask",
    config: { message: "?", payloadRef: null, responseSchemaRef: null },
  } as GraphIR["nodes"][number]);
  sub.edges.push({ from: "n_inner_b", to: "n_inner_ask" });
  assert.throws(() => generateLangGraphProject(ir), CodegenError);
});

test("langgraph rejects a nested workflow with multiple leaves loud", () => {
  // A second leaf that still passes the compileEdges shape gate needs a
  // router: both branch targets are terminal, so the sub-graph has two leaves
  // and no single output key to feed the parent.
  const ir = loadIR("packages/ir/fixtures/nested.ir.json");
  const wf = ir.nodes.find((n) => n.type === "workflow")!;
  const sub = (wf.config as { graph: GraphIR }).graph;
  sub.nodes.push(
    {
      id: "n_inner_router",
      type: "router",
      name: "inner_router",
      config: { routes: ["A", "B"], inputType: "str", body: null },
    } as GraphIR["nodes"][number],
    {
      id: "n_inner_c",
      type: "function",
      name: "inner_step_c",
      config: { inputType: "str", outputType: "str", body: null },
    } as GraphIR["nodes"][number],
  );
  sub.edges.push(
    { from: "n_inner_b", to: "n_inner_router" },
    { from: "n_inner_router", to: "n_inner_c", route: "A" },
    { from: "n_inner_router", to: "n_inner_c2", route: "B" },
  );
  sub.nodes.push({
    id: "n_inner_c2",
    type: "function",
    name: "inner_step_c2",
    config: { inputType: "str", outputType: "str", body: null },
  } as GraphIR["nodes"][number]);
  assert.throws(() => generateLangGraphProject(ir), CodegenError);
});
