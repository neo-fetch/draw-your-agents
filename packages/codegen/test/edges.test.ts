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

test("rejects parallel fan-out (a node with multiple out-edges)", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "fan_out",
    schemas: [],
    nodes: [
      { id: "a", type: "function", name: "a", config: { inputType: "str", outputType: "str" } },
      { id: "b", type: "function", name: "b", config: { inputType: "str", outputType: "str" } },
      { id: "c", type: "function", name: "c", config: { inputType: "str", outputType: "str" } },
    ],
    edges: [
      { from: "START", to: "a" },
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ],
  };
  assert.throws(() => compileEdges(ir), /fans out/);
});

test("rejects a router node as out of slice", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "has_router",
    schemas: [],
    nodes: [
      { id: "r", type: "router", name: "r", config: { routes: ["X"] } },
    ],
    edges: [{ from: "START", to: "r" }],
  };
  assert.throws(() => compileEdges(ir), /router/);
});
