/**
 * Headless test for the sub-graph navigation helpers (ADR-0050).
 *
 * Pins the contracts the zoom-into-sub-graph slice builds on:
 * (a) `graphAtPath` resolves by reference (zero allocation) and rejects
 *     missing / non-workflow segments; (b) `updateGraphAtPath` rebuilds only
 *     the spine, preserves sibling referential identity, and short-circuits
 *     no-ops to the same root reference; (c) `breadcrumbItems` / `prunePath`
 *     navigation plumbing; (d) `resolveFindingPath` maps the validator's
 *     path-prefixed finding ids ("n_outer/n_inner", ADR-0017) to a navigable
 *     {path, nodeId} with the deepest-valid-prefix fallback.
 *
 * Runs under `node --test` against the native TS loader — no `npm install`
 * (ADR-0011 / ADR-0013), no zustand, no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FunctionNode, GraphIR, WorkflowNode } from "@graphical-agents/ir";
import {
  breadcrumbItems,
  graphAtPath,
  prunePath,
  resolveFindingPath,
  selectActiveGraph,
  updateGraphAtPath,
} from "../src/store/subgraph.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function loadNested(): GraphIR {
  return JSON.parse(
    readFileSync(join(fixturesDir, "nested.ir.json"), "utf8"),
  ) as GraphIR;
}

/** Two-deep IR: root → workflow w1 → workflow w2 → function leaf. */
function twoDeep(): GraphIR {
  const leaf: FunctionNode = {
    id: "n_leaf",
    type: "function",
    name: "leaf_fn",
    config: { description: "", inputType: "str", outputType: "str", emits: "output", body: null },
  };
  const w2: WorkflowNode = {
    id: "n_w2",
    type: "workflow",
    name: "wf_inner",
    config: {
      graph: {
        irVersion: "0.1.0",
        name: "wf_inner",
        schemas: [],
        nodes: [leaf],
        edges: [{ from: "START", to: "n_leaf" }],
      },
    },
  };
  const w1: WorkflowNode = {
    id: "n_w1",
    type: "workflow",
    name: "wf_outer",
    config: {
      graph: {
        irVersion: "0.1.0",
        name: "wf_outer",
        schemas: [],
        nodes: [w2],
        edges: [{ from: "START", to: "n_w2" }],
      },
    },
  };
  return {
    irVersion: "0.1.0",
    name: "two_deep",
    schemas: [],
    nodes: [w1],
    edges: [{ from: "START", to: "n_w1" }],
  };
}

// --- graphAtPath ----------------------------------------------------------

test("graphAtPath([]) returns the root by reference", () => {
  const ir = loadNested();
  assert.equal(graphAtPath(ir, []), ir);
});

test("graphAtPath resolves one level by reference", () => {
  const ir = loadNested();
  const wf = ir.nodes.find((n) => n.id === "n_nested") as WorkflowNode;
  assert.equal(graphAtPath(ir, ["n_nested"]), wf.config.graph);
});

test("graphAtPath resolves a two-deep path", () => {
  const ir = twoDeep();
  const g = graphAtPath(ir, ["n_w1", "n_w2"]);
  assert.ok(g);
  assert.equal(g.nodes[0].id, "n_leaf");
});

test("graphAtPath rejects unknown and non-workflow segments", () => {
  const ir = loadNested();
  assert.equal(graphAtPath(ir, ["n_missing"]), undefined);
  // n_preprocess exists but is a function, not a workflow.
  assert.equal(graphAtPath(ir, ["n_preprocess"]), undefined);
  assert.equal(graphAtPath(ir, ["n_nested", "n_inner_a"]), undefined);
});

// --- updateGraphAtPath ----------------------------------------------------

test("updateGraphAtPath rebuilds the spine, siblings keep identity", () => {
  const ir = loadNested();
  const before = JSON.stringify(ir);
  const sibling = ir.nodes.find((n) => n.id === "n_preprocess");
  const next = updateGraphAtPath(ir, ["n_nested"], (g) => ({
    ...g,
    nodes: g.nodes.filter((n) => n.id !== "n_inner_b"),
  }));

  assert.notEqual(next, ir, "root is a new object");
  const nextWf = next.nodes.find((n) => n.id === "n_nested") as WorkflowNode;
  const prevWf = ir.nodes.find((n) => n.id === "n_nested") as WorkflowNode;
  assert.notEqual(nextWf, prevWf, "workflow node on the spine is new");
  assert.equal(nextWf.config.graph.nodes.length, 1);
  assert.equal(
    next.nodes.find((n) => n.id === "n_preprocess"),
    sibling,
    "sibling keeps referential identity",
  );
  assert.equal(next.edges, ir.edges, "root edges array untouched");
  assert.equal(JSON.stringify(ir), before, "pure: input untouched");
});

test("updateGraphAtPath two-deep edit rebuilds both spine levels", () => {
  const ir = twoDeep();
  const next = updateGraphAtPath(ir, ["n_w1", "n_w2"], (g) => ({
    ...g,
    name: "renamed_inner",
  }));
  const w1 = next.nodes[0] as WorkflowNode;
  const w2 = w1.config.graph.nodes[0] as WorkflowNode;
  assert.equal(w2.config.graph.name, "renamed_inner");
  // Original untouched at every level.
  const ow1 = ir.nodes[0] as WorkflowNode;
  const ow2 = ow1.config.graph.nodes[0] as WorkflowNode;
  assert.equal(ow2.config.graph.name, "wf_inner");
});

test("updateGraphAtPath no-ops: invalid path and identity fn return same ref", () => {
  const ir = loadNested();
  assert.equal(updateGraphAtPath(ir, ["n_missing"], (g) => ({ ...g })), ir);
  assert.equal(updateGraphAtPath(ir, ["n_nested"], (g) => g), ir);
});

// --- breadcrumbItems / prunePath / selectActiveGraph -----------------------

test("breadcrumbItems lists workflow nodes along the path", () => {
  const ir = twoDeep();
  assert.deepEqual(breadcrumbItems(ir, ["n_w1", "n_w2"]), [
    { id: "n_w1", name: "wf_outer" },
    { id: "n_w2", name: "wf_inner" },
  ]);
  assert.deepEqual(breadcrumbItems(ir, []), []);
  assert.equal(breadcrumbItems(ir, ["n_w1", "nope"]), undefined);
});

test("prunePath truncates at the deleted id; same ref on miss", () => {
  const path = ["n_w1", "n_w2"];
  assert.deepEqual(prunePath(path, "n_w1"), []);
  assert.deepEqual(prunePath(path, "n_w2"), ["n_w1"]);
  assert.equal(prunePath(path, "n_other"), path);
});

test("selectActiveGraph falls back to root on an invalid path", () => {
  const ir = loadNested();
  const wf = ir.nodes.find((n) => n.id === "n_nested") as WorkflowNode;
  assert.equal(selectActiveGraph({ ir, subgraphPath: ["n_nested"] }), wf.config.graph);
  assert.equal(selectActiveGraph({ ir, subgraphPath: ["gone"] }), ir);
});

// --- resolveFindingPath ----------------------------------------------------

test("resolveFindingPath: top-level id resolves at the root path", () => {
  const ir = loadNested();
  assert.deepEqual(resolveFindingPath(ir, "n_preprocess"), {
    path: [],
    nodeId: "n_preprocess",
  });
  // A workflow node's own finding selects it at the root, not inside it.
  assert.deepEqual(resolveFindingPath(ir, "n_nested"), {
    path: [],
    nodeId: "n_nested",
  });
});

test("resolveFindingPath: nested finding zooms into the owning sub-graph", () => {
  const ir = loadNested();
  assert.deepEqual(resolveFindingPath(ir, "n_nested/n_inner_a"), {
    path: ["n_nested"],
    nodeId: "n_inner_a",
  });
  const deep = twoDeep();
  assert.deepEqual(resolveFindingPath(deep, "n_w1/n_w2/n_leaf"), {
    path: ["n_w1", "n_w2"],
    nodeId: "n_leaf",
  });
});

test("resolveFindingPath: prefix-only ids fall back to the deepest valid location", () => {
  const ir = loadNested();
  // The inner id is gone (stale finding) → land on the enclosing workflow.
  assert.deepEqual(resolveFindingPath(ir, "n_nested/n_gone"), {
    path: [],
    nodeId: "n_nested",
  });
  const deep = twoDeep();
  assert.deepEqual(resolveFindingPath(deep, "n_w1/n_w2/n_gone"), {
    path: ["n_w1"],
    nodeId: "n_w2",
  });
});

test("resolveFindingPath: unresolvable ids return null", () => {
  const ir = loadNested();
  assert.equal(resolveFindingPath(ir, "n_gone"), null);
  assert.equal(resolveFindingPath(ir, "n_gone/n_inner_a"), null);
  assert.equal(resolveFindingPath(ir, undefined), null);
});
