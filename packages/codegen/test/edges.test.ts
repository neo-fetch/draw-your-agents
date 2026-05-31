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
import type { GraphIR } from "@graphical-agents/ir";
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

test("rejects a branch continuation (a non-terminal router target) loud", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "branch_continues",
    schemas: [],
    nodes: [
      { id: "r", type: "router", name: "r", config: { routes: ["X"] } },
      { id: "a", type: "function", name: "a", config: { inputType: "str", outputType: "str" } },
      { id: "b", type: "function", name: "b", config: { inputType: "str", outputType: "str" } },
    ],
    edges: [
      { from: "START", to: "r" },
      { from: "r", to: "a", route: "X" },
      { from: "a", to: "b" },
    ],
  };
  assert.throws(() => compileEdges(ir), /branch continuation/);
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
