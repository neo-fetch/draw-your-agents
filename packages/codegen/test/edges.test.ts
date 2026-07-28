/**
 * Golden-file tests for the edges compiler (ADR-0009).
 * The golden fixtures are the codegen spec: an IR in, an ADK `edges=[...]`
 * fragment out. Runs on Node's native TypeScript support — no build step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR, GraphNode } from "@graphical-agents/ir";
import { compileEdges, renderEdgeRows, EdgesCompilerError } from "../src/edges.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function loadIR(relPath: string): GraphIR {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as GraphIR;
}

function loadGolden(name: string): string {
  return readFileSync(join(here, "golden", name), "utf8").trim();
}

test("city-time: linear chain collapses to a single START row", () => {
  const ir = loadIR("packages/ir/fixtures/city-time.ir.json");
  const rendered = renderEdgeRows(compileEdges(ir));
  assert.equal(rendered, loadGolden("city-time.edges.txt"));
});

test("city-time: produces exactly one row with START + four nodes", () => {
  const rows = compileEdges(loadIR("packages/ir/fixtures/city-time.ir.json"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], [
    { kind: "start" },
    { kind: "node", name: "city_generator" },
    { kind: "node", name: "lookup_time" },
    { kind: "node", name: "city_report" },
    { kind: "node", name: "completed_message" },
  ]);
});

test("rejects a graph with no START edge", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "no_entry",
    schemas: [],
    nodes: [{ id: "a", type: "function", name: "a", config: { inputType: "str", outputType: "str" } }],
    edges: [],
  };
  assert.throws(() => compileEdges(ir), EdgesCompilerError);
});

test("routing: router collapses to an entry chain + a route-map row", () => {
  const ir = loadIR("packages/ir/fixtures/routing.ir.json");
  const rendered = renderEdgeRows(compileEdges(ir));
  assert.equal(rendered, loadGolden("routing.edges.txt"));
});

test("routing: produces an entry chain row + a route-map row in declared order", () => {
  const rows = compileEdges(loadIR("packages/ir/fixtures/routing.ir.json"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], [
    { kind: "start" },
    { kind: "node", name: "process_message" },
    { kind: "node", name: "router" },
  ]);
  assert.deepEqual(rows[1], [
    { kind: "node", name: "router" },
    {
      kind: "routeMap",
      entries: [
        { route: "BUG", target: "handle_bug" },
        { route: "CUSTOMER_SUPPORT", target: "handle_customer_support" },
        { route: "LOGISTICS", target: "handle_logistics" },
      ],
    },
  ]);
});

// -- router branch continuations (ADR-0054) --
//
// A branch target need not be terminal. A target with its own out-edges gets a
// continuation row **headed by that target** — the same interior-row-head rule
// ADR-0015's `(join, continuation)` row and ADR-0048's fan-out rows use.

const fn = (name: string): GraphNode => ({
  id: name,
  type: "function",
  name,
  config: { inputType: "str", outputType: "str" },
});

test("routing-continue: entry chain + route map + a branch continuation row", () => {
  const ir = loadIR("packages/ir/fixtures/routing-continue.ir.json");
  const rendered = renderEdgeRows(compileEdges(ir));
  assert.equal(rendered, loadGolden("routing-continue.edges.txt"));
});

test("routing-continue: the continuation row is headed by the branch target", () => {
  const rows = compileEdges(loadIR("packages/ir/fixtures/routing-continue.ir.json"));
  assert.equal(rows.length, 3, "expected entry chain + route map + 1 continuation row");
  assert.deepEqual(rows[0], [
    { kind: "start" },
    { kind: "node", name: "assess_request" },
    { kind: "node", name: "feasibility_router" },
  ]);
  assert.deepEqual(rows[1], [
    { kind: "node", name: "feasibility_router" },
    {
      kind: "routeMap",
      entries: [
        { route: "FEASIBLE", target: "generate_code" },
        { route: "INFEASIBLE", target: "explain_blockers" },
      ],
    },
  ]);
  // The terminal branch (explain_blockers) contributes no row at all.
  assert.deepEqual(rows[2], [
    { kind: "node", name: "generate_code" },
    { kind: "node", name: "run_tests" },
    { kind: "node", name: "summarize_result" },
  ]);
});

test("branch continuations follow declared route order, not edge order", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "declared_order",
    schemas: [],
    nodes: [
      { id: "r", type: "router", name: "r", config: { routes: ["X", "Y"] } },
      fn("a"),
      fn("a_next"),
      fn("b"),
      fn("b_next"),
    ],
    // Edges deliberately list the Y branch first.
    edges: [
      { from: "START", to: "r" },
      { from: "r", to: "b", route: "Y" },
      { from: "r", to: "a", route: "X" },
      { from: "b", to: "b_next" },
      { from: "a", to: "a_next" },
    ],
  };
  assert.equal(
    renderEdgeRows(compileEdges(ir)),
    'edges=[("START", r), (r, {"X": a, "Y": b}), (a, a_next), (b, b_next)]',
  );
});

test("a nested router as a branch target chains a second route-map row", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "nested_router",
    schemas: [],
    nodes: [
      { id: "r1", type: "router", name: "r1", config: { routes: ["X", "Y"] } },
      { id: "r2", type: "router", name: "r2", config: { routes: ["P", "Q"] } },
      fn("p"),
      fn("p_next"),
      fn("q"),
      fn("y"),
    ],
    edges: [
      { from: "START", to: "r1" },
      { from: "r1", to: "r2", route: "X" },
      { from: "r1", to: "y", route: "Y" },
      { from: "r2", to: "p", route: "P" },
      { from: "r2", to: "q", route: "Q" },
      { from: "p", to: "p_next" },
    ],
  };
  assert.equal(
    renderEdgeRows(compileEdges(ir)),
    'edges=[("START", r1), (r1, {"X": r2, "Y": y}), (r2, {"P": p, "Q": q}), (p, p_next)]',
  );
});

test("a branch target shared by two routes yields exactly one continuation row", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "shared_target",
    schemas: [],
    nodes: [
      { id: "r", type: "router", name: "r", config: { routes: ["X", "Y"] } },
      fn("t"),
      fn("t_next"),
    ],
    edges: [
      { from: "START", to: "r" },
      { from: "r", to: "t", route: "X" },
      { from: "r", to: "t", route: "Y" },
      { from: "t", to: "t_next" },
    ],
  };
  assert.equal(
    renderEdgeRows(compileEdges(ir)),
    'edges=[("START", r), (r, {"X": t, "Y": t}), (t, t_next)]',
  );
});

test("rejects two branch continuations merging on a shared node loud", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "branches_merge",
    schemas: [],
    nodes: [
      { id: "r", type: "router", name: "r", config: { routes: ["X", "Y"] } },
      fn("a"),
      fn("b"),
      fn("m"),
    ],
    edges: [
      { from: "START", to: "r" },
      { from: "r", to: "a", route: "X" },
      { from: "r", to: "b", route: "Y" },
      { from: "a", to: "m" },
      { from: "b", to: "m" },
    ],
  };
  assert.throws(() => compileEdges(ir), /joins\/merges are not handled by this slice/);
});

// -- parallel fan-out + join tests (ADR-0015) --

test("parallel: fan-out rows + join continuation matches golden", () => {
  const ir = loadIR("packages/ir/fixtures/parallel.ir.json");
  const rendered = renderEdgeRows(compileEdges(ir));
  assert.equal(rendered, loadGolden("parallel.edges.txt"));
});

test("parallel: produces N fan-out rows + 1 continuation row", () => {
  const rows = compileEdges(loadIR("packages/ir/fixtures/parallel.ir.json"));
  assert.equal(rows.length, 4, "expected 3 fan-out rows + 1 continuation row");
  // Fan-out rows: ("START", branch, join)
  assert.deepEqual(rows[0], [
    { kind: "start" },
    { kind: "node", name: "task_a" },
    { kind: "node", name: "my_join_node" },
  ]);
  assert.deepEqual(rows[1], [
    { kind: "start" },
    { kind: "node", name: "task_b" },
    { kind: "node", name: "my_join_node" },
  ]);
  assert.deepEqual(rows[2], [
    { kind: "start" },
    { kind: "node", name: "task_c" },
    { kind: "node", name: "my_join_node" },
  ]);
  // Continuation row: (join, final)
  assert.deepEqual(rows[3], [
    { kind: "node", name: "my_join_node" },
    { kind: "node", name: "final_task_d" },
  ]);
});

// -- mid-graph fan-out (ADR-0048) --

test("parallel-mid: prefix row + fan-out rows + continuation matches golden", () => {
  const ir = loadIR("packages/ir/fixtures/parallel-mid.ir.json");
  const rendered = renderEdgeRows(compileEdges(ir));
  assert.equal(rendered, loadGolden("parallel-mid.edges.txt"));
});

test("parallel-mid: produces a prefix row + 2 fan-out rows + 1 continuation row", () => {
  const rows = compileEdges(loadIR("packages/ir/fixtures/parallel-mid.ir.json"));
  assert.equal(rows.length, 4, "expected 1 prefix row + 2 fan-out rows + 1 continuation row");
  // Prefix row: ("START", prep) — closes at the fan-out node.
  assert.deepEqual(rows[0], [
    { kind: "start" },
    { kind: "node", name: "prep" },
  ]);
  // Fan-out rows headed by the fan-out node: (prep, branch, join)
  assert.deepEqual(rows[1], [
    { kind: "node", name: "prep" },
    { kind: "node", name: "task_a" },
    { kind: "node", name: "my_join" },
  ]);
  assert.deepEqual(rows[2], [
    { kind: "node", name: "prep" },
    { kind: "node", name: "task_b" },
    { kind: "node", name: "my_join" },
  ]);
  // Continuation row: (join, final)
  assert.deepEqual(rows[3], [
    { kind: "node", name: "my_join" },
    { kind: "node", name: "final_task" },
  ]);
});

test("parallel-mid: rejects nested fan-out inside a branch loud", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "nested_fan_out",
    schemas: [],
    nodes: [
      { id: "p", type: "function", name: "p", config: { inputType: "str", outputType: "str" } },
      { id: "a", type: "function", name: "a", config: { inputType: "str", outputType: "str" } },
      { id: "b", type: "function", name: "b", config: { inputType: "str", outputType: "str" } },
      { id: "c", type: "function", name: "c", config: { inputType: "str", outputType: "str" } },
      { id: "j", type: "join", name: "j", config: {} },
    ],
    edges: [
      { from: "START", to: "p" },
      { from: "p", to: "a" },
      { from: "p", to: "b" },
      { from: "a", to: "c" },
      { from: "a", to: "j" },
      { from: "b", to: "j" },
      { from: "c", to: "j" },
    ],
  };
  assert.throws(() => compileEdges(ir), /nested fan-out/);
});

test("parallel-mid: rejects a branch that does not reach a join loud", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "branch_no_join",
    schemas: [],
    nodes: [
      { id: "p", type: "function", name: "p", config: { inputType: "str", outputType: "str" } },
      { id: "a", type: "function", name: "a", config: { inputType: "str", outputType: "str" } },
      { id: "b", type: "function", name: "b", config: { inputType: "str", outputType: "str" } },
    ],
    edges: [
      { from: "START", to: "p" },
      { from: "p", to: "a" },
      { from: "p", to: "b" },
    ],
  };
  assert.throws(() => compileEdges(ir), /does not reach a join/);
});

test("parallel-mid: rejects fan-out after the join loud", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "fan_out_after_join",
    schemas: [],
    nodes: [
      { id: "p", type: "function", name: "p", config: { inputType: "str", outputType: "str" } },
      { id: "a", type: "function", name: "a", config: { inputType: "str", outputType: "str" } },
      { id: "b", type: "function", name: "b", config: { inputType: "str", outputType: "str" } },
      { id: "j", type: "join", name: "j", config: {} },
      { id: "x", type: "function", name: "x", config: { inputType: "str", outputType: "str" } },
      { id: "y", type: "function", name: "y", config: { inputType: "str", outputType: "str" } },
    ],
    edges: [
      { from: "START", to: "p" },
      { from: "p", to: "a" },
      { from: "p", to: "b" },
      { from: "a", to: "j" },
      { from: "b", to: "j" },
      { from: "j", to: "x" },
      { from: "j", to: "y" },
    ],
  };
  assert.throws(() => compileEdges(ir), /multi-out after join/);
});

// -- humanInput linear chain (ADR-0016) --

test("human-input: linear chain through ask_user → process_response matches golden", () => {
  const ir = loadIR("packages/ir/fixtures/human-input.ir.json");
  const rendered = renderEdgeRows(compileEdges(ir));
  assert.equal(rendered, loadGolden("human-input.edges.txt"));
});

test("human-input: produces one linear row with START + humanInput + downstream", () => {
  const rows = compileEdges(loadIR("packages/ir/fixtures/human-input.ir.json"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], [
    { kind: "start" },
    { kind: "node", name: "ask_user" },
    { kind: "node", name: "process_response" },
  ]);
});

// -- tool linear chain (ADR-0019) --
//
// A tool node is a plain linear-chain member in its parent's rows — the edge
// symbol is the tool's function (`<node_name>`), defined in functions.py
// (plain function node since E2E finding F3; no FunctionTool wrapper).

test("tool: linear chain through fetch_data → summarize matches golden", () => {
  const ir = loadIR("packages/ir/fixtures/tool.ir.json");
  const rendered = renderEdgeRows(compileEdges(ir));
  assert.equal(rendered, loadGolden("tool.edges.txt"));
});

test("tool: produces one linear row with the tool node as a plain member", () => {
  const rows = compileEdges(loadIR("packages/ir/fixtures/tool.ir.json"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], [
    { kind: "start" },
    { kind: "node", name: "fetch_data" },
    { kind: "node", name: "summarize" },
  ]);
});

// -- nested workflow linear chain (ADR-0018) --
//
// `compileEdges` does not recurse into a workflow node's sub-graph — the node
// is a plain linear-chain member in the parent's rows, and the project
// assembler compiles each sub-graph separately (ADR-0018). These tests pin
// only the **parent** rows.

test("nested: parent chain treats nested_workflow as a plain linear-chain member", () => {
  const ir = loadIR("packages/ir/fixtures/nested.ir.json");
  const rendered = renderEdgeRows(compileEdges(ir));
  assert.equal(rendered, loadGolden("nested.edges.txt"));
});

test("nested: parent rows include the workflow node as a {kind:node}", () => {
  const rows = compileEdges(loadIR("packages/ir/fixtures/nested.ir.json"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], [
    { kind: "start" },
    { kind: "node", name: "preprocess" },
    { kind: "node", name: "nested_workflow" },
    { kind: "node", name: "finalize" },
  ]);
});
