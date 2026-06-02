/**
 * Headless test for the addNode reducer (ADR-0025).
 *
 * No UI golden oracle — the test pins the contract the minter exists to
 * uphold: (a) every node-type default config is valid-by-construction so
 * the only finding on a fresh, disconnected add is `UNREACHABLE_NODE`
 * on the new node; (b) ids and names are pairwise distinct; (c) the
 * uniqueness walk descends into `workflow.config.graph` sub-IRs (ADR-0017
 * flat global namespace); (d) the default `workflow` sub-IR is itself
 * valid; (e) the reducer is pure.
 *
 * Runs under `node --test` against the native TS loader — no `npm install`
 * (ADR-0011 / ADR-0013), no zustand, no browser. Mirrors the posture of
 * `irStore.test.ts` (ADR-0022).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  FunctionNode,
  GraphIR,
  NodeType,
  WorkflowNode,
} from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { cloneFixture } from "../src/store/irReducer.ts";
import {
  addNode,
  collectAllIds,
  collectAllNames,
  makeNodeId,
  makeNodeName,
} from "../src/store/addNode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function loadCityTime(): GraphIR {
  return JSON.parse(readFileSync(join(fixturesDir, "city-time.ir.json"), "utf8")) as GraphIR;
}
function loadNested(): GraphIR {
  return JSON.parse(readFileSync(join(fixturesDir, "nested.ir.json"), "utf8")) as GraphIR;
}

const ALL_TYPES: NodeType[] = [
  "agent",
  "function",
  "router",
  "tool",
  "join",
  "humanInput",
  "workflow",
];

/**
 * Expected error codes on a freshly added, disconnected node of each type.
 * All of these are *graph-shape* errors that disappear once edges are wired
 * up by the next slice — not "missing config field" errors. For most types
 * the only one is UNREACHABLE_NODE; `router` additionally raises
 * ROUTER_ROUTE_NO_TARGET because its (required) declared route has no
 * out-edge yet (ADR-0025: routers can't be added in a state where the
 * route-edge invariant 7 holds without simultaneously creating an edge).
 */
const EXPECTED_FRESH_ERROR_CODES: Record<NodeType, ReadonlyArray<string>> = {
  agent: ["UNREACHABLE_NODE"],
  function: ["UNREACHABLE_NODE"],
  router: ["ROUTER_ROUTE_NO_TARGET", "UNREACHABLE_NODE"],
  tool: ["UNREACHABLE_NODE"],
  join: ["UNREACHABLE_NODE"],
  humanInput: ["UNREACHABLE_NODE"],
  workflow: ["UNREACHABLE_NODE"],
};

// --- (a) Default-config validity for every type --------------------------

for (const type of ALL_TYPES) {
  test(`addNode(${type}) yields only the expected disconnected-shape errors on the new node`, () => {
    const initial = cloneFixture(loadCityTime());
    const { ir: next, nodeId } = addNode(initial, type);

    const result = validate(next);
    // Every error must be one of the expected codes AND scoped to the new node.
    // Proves there are no "missing field" / "wrong default" errors on the new
    // node, and no spurious findings elsewhere in the IR.
    const expectedSet = new Set(EXPECTED_FRESH_ERROR_CODES[type]);
    const gotCodes = result.errors.map((f) => f.code).sort();
    assert.deepStrictEqual(
      gotCodes,
      [...EXPECTED_FRESH_ERROR_CODES[type]].sort(),
      `expected ${JSON.stringify(EXPECTED_FRESH_ERROR_CODES[type])}, got: ${JSON.stringify(result.errors)}`,
    );
    for (const f of result.errors) {
      assert.ok(expectedSet.has(f.code));
      assert.strictEqual(f.nodeId, nodeId, `finding ${f.code} must scope to the new node`);
    }

    // The newly added node is the last in the array, with the minted id.
    const added = next.nodes[next.nodes.length - 1]!;
    assert.strictEqual(added.id, nodeId);
    assert.strictEqual(added.type, type);
  });
}

// --- (b) Pairwise distinct ids + names -----------------------------------

for (const type of ALL_TYPES) {
  test(`adding two ${type} nodes yields distinct ids and names`, () => {
    const initial = cloneFixture(loadCityTime());
    const first = addNode(initial, type);
    const second = addNode(first.ir, type);

    assert.notStrictEqual(first.nodeId, second.nodeId, "ids must differ");

    const firstNode = first.ir.nodes[first.ir.nodes.length - 1]!;
    const secondNode = second.ir.nodes[second.ir.nodes.length - 1]!;
    assert.notStrictEqual(firstNode.name, secondNode.name, "names must differ");

    // Both must validate to identifier shape — proved indirectly by the
    // validator pass below, but check at least one structural property.
    assert.match(firstNode.name, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.match(secondNode.name, /^[A-Za-z_][A-Za-z0-9_]*$/);

    const result = validate(second.ir);
    // Two disconnected nodes ⇒ two of each expected code, nothing else.
    const expectedCount = EXPECTED_FRESH_ERROR_CODES[type].length * 2;
    assert.strictEqual(result.errors.length, expectedCount, JSON.stringify(result.errors));
    const expectedSet = new Set(EXPECTED_FRESH_ERROR_CODES[type]);
    for (const f of result.errors) assert.ok(expectedSet.has(f.code), `unexpected code ${f.code}`);
  });
}

// --- (c) Cross-graph collision avoidance ---------------------------------

test("makeNodeName walks into workflow.config.graph (parent-level collision)", () => {
  // Parent already has `nested_workflow` at top level — so adding a workflow
  // must skip past `workflow_1`-or-equal collisions only if `workflow_1`
  // exists. To pin the descent specifically, see the next test which
  // plants a colliding name *inside* the sub-graph.
  const nested = cloneFixture(loadNested());
  const name = makeNodeName(nested, "workflow");
  // workflow_1 doesn't collide with anything in nested.ir.json directly;
  // the assertion is just that the minter produces a unique name overall.
  assert.ok(
    !collectAllNames(nested).has(name),
    `minted name ${name} must not collide with any existing name`,
  );
});

test("collectAllNames descends into workflow.config.graph", () => {
  const nested = cloneFixture(loadNested());
  const names = collectAllNames(nested);
  // Parent-level
  assert.ok(names.has("preprocess"), "parent function name must appear");
  assert.ok(names.has("nested_workflow"), "parent workflow name must appear");
  assert.ok(names.has("finalize"), "parent function name must appear");
  // Inner sub-graph
  assert.ok(names.has("inner_step_a"), "nested function name must appear (proves descent)");
  assert.ok(names.has("inner_step_b"), "nested function name must appear (proves descent)");
});

test("collectAllIds descends into workflow.config.graph", () => {
  const nested = cloneFixture(loadNested());
  const ids = collectAllIds(nested);
  assert.ok(ids.has("n_preprocess"));
  assert.ok(ids.has("n_nested"));
  assert.ok(ids.has("n_inner_a"), "nested id must appear (proves descent)");
  assert.ok(ids.has("n_inner_b"), "nested id must appear (proves descent)");
});

test("makeNodeName avoids a name planted INSIDE a nested sub-graph", () => {
  // Plant `function_1` inside the nested sub-graph; the parent IR does not
  // contain that name at top level. A non-recursive walker would mint
  // `function_1` and collide — the recursive walker must skip to `function_2`.
  const nested = cloneFixture(loadNested());
  const workflowNode = nested.nodes.find((n) => n.type === "workflow") as WorkflowNode;
  workflowNode.config.graph.nodes.push({
    id: "n_planted",
    type: "function",
    name: "function_1",
    ui: { x: 0, y: 0 },
    config: { description: "", inputType: "str", outputType: "str", emits: "output", body: null },
  });

  const minted = makeNodeName(nested, "function");
  assert.notStrictEqual(minted, "function_1", "must skip name planted in nested sub-graph");
  assert.strictEqual(minted, "function_2");

  const mintedId = makeNodeId(nested, "function");
  // n_function_1 isn't planted (we planted n_planted) so id is free at suffix 1.
  assert.strictEqual(mintedId, "n_function_1");
});

test("makeNodeId avoids an id planted INSIDE a nested sub-graph", () => {
  const nested = cloneFixture(loadNested());
  const workflowNode = nested.nodes.find((n) => n.type === "workflow") as WorkflowNode;
  workflowNode.config.graph.nodes.push({
    id: "n_function_1",
    type: "function",
    name: "planted_inner",
    ui: { x: 0, y: 0 },
    config: { description: "", inputType: "str", outputType: "str", emits: "output", body: null },
  });

  const mintedId = makeNodeId(nested, "function");
  assert.notStrictEqual(mintedId, "n_function_1", "must skip id planted in nested sub-graph");
  assert.strictEqual(mintedId, "n_function_2");
});

// --- (d) Workflow default sub-IR validates -------------------------------

test("addNode(workflow) default sub-IR is itself valid (one-node passthrough)", () => {
  const initial = cloneFixture(loadCityTime());
  const { ir: next, nodeId } = addNode(initial, "workflow");

  // Combined validate: only the parent-level UNREACHABLE_NODE for the new
  // workflow node — nothing nested. (A truly empty sub-IR would fail
  // NO_START_EDGE inside, surfacing more errors here.)
  const result = validate(next);
  assert.strictEqual(result.errors.length, 1, JSON.stringify(result.errors));
  assert.strictEqual(result.errors[0]!.code, "UNREACHABLE_NODE");
  assert.strictEqual(result.errors[0]!.nodeId, nodeId);

  // The sub-IR has one node + one START edge to it.
  const added = next.nodes[next.nodes.length - 1]! as WorkflowNode;
  const sub = added.config.graph;
  assert.strictEqual(sub.nodes.length, 1);
  assert.strictEqual(sub.edges.length, 1);
  assert.strictEqual(sub.edges[0]!.from, "START");
  assert.strictEqual(sub.edges[0]!.to, sub.nodes[0]!.id);
  // Inner node's name lives in the flat global namespace and must not
  // collide with the new workflow node's own name.
  assert.notStrictEqual(sub.nodes[0]!.name, added.name);

  // Adding another workflow must not re-mint the inner name from the first.
  const second = addNode(next, "workflow");
  const secondInnerName = ((second.ir.nodes[second.ir.nodes.length - 1] as WorkflowNode).config.graph.nodes[0]!).name;
  assert.notStrictEqual(secondInnerName, (sub.nodes[0] as FunctionNode).name);
  // And the combined IR still only has UNREACHABLE_NODE errors (one per
  // disconnected workflow at parent level).
  const r2 = validate(second.ir);
  assert.strictEqual(r2.errors.length, 2);
  for (const f of r2.errors) assert.strictEqual(f.code, "UNREACHABLE_NODE");
});

// --- (e) Purity ----------------------------------------------------------

test("addNode is pure: input IR is not mutated and sibling nodes stay referentially equal", () => {
  const initial = cloneFixture(loadCityTime());
  const before = initial.nodes.length;
  const beforeFirstNode = initial.nodes[0];

  const { ir: next } = addNode(initial, "agent");

  assert.strictEqual(initial.nodes.length, before, "original IR.nodes is untouched");
  assert.strictEqual(initial.nodes[0], beforeFirstNode, "original node[0] reference preserved");
  assert.notStrictEqual(next, initial, "returned a new IR object");
  assert.notStrictEqual(next.nodes, initial.nodes, "returned a new nodes array");
  // Existing siblings keep their identity in the new array.
  for (let i = 0; i < initial.nodes.length; i++) {
    assert.strictEqual(next.nodes[i], initial.nodes[i], `sibling ${i} referentially equal`);
  }
});

// --- (f) Drop-at-position (ADR-0034) -------------------------------------

test("addNode places the node at an explicit drop position, else falls back to the stagger", () => {
  const ir = cloneFixture(loadCityTime());

  // Explicit position (drag-and-drop drop point) is written verbatim to ui.
  const dropped = addNode(ir, "agent", { x: 137, y: -42 });
  const droppedNode = dropped.ir.nodes[dropped.ir.nodes.length - 1]!;
  assert.deepStrictEqual(droppedNode.ui, { x: 137, y: -42 });

  // Omitting the position keeps the staggered default (click-to-add path):
  // it must NOT collapse to the drop coords, and must sit right of the graph.
  const staggered = addNode(ir, "agent");
  const staggeredNode = staggered.ir.nodes[staggered.ir.nodes.length - 1]!;
  const maxExistingX = Math.max(...ir.nodes.map((n) => n.ui?.x ?? 0));
  assert.ok(
    (staggeredNode.ui?.x ?? 0) > maxExistingX,
    "staggered node sits to the right of the existing graph",
  );
});
