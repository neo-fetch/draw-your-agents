/**
 * Install-required store-action tests for `createIRStore` (ADR-0022/0024/
 * 0026/0028). Lives in the second test tier introduced by ADR-0031 and
 * generalized to `test-app/` by ADR-0032: the store imports `zustand` at
 * runtime, so this file cannot live under `apps/web/test/` without
 * breaking the install-free cold-checkout gate (ADR-0011 / ADR-0013).
 *
 * Pure-reducer + bridge coverage for the same surface lives in
 * `apps/web/test/irReducer.test.ts` and stays install-free.
 *
 * Run via `npm run test:web:app` from the repo root, after `npm install`
 * inside `apps/web/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/index.ts";
import {
  applyNodeConfigPatch,
  cloneFixture,
} from "../src/store/irReducer.ts";
import { createIRStore } from "../src/store/irStore.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");
const fixturePath = join(fixturesDir, "city-time.ir.json");
const routingFixturePath = join(fixturesDir, "routing.ir.json");

function loadFixture(): GraphIR {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as GraphIR;
}
function loadRoutingFixture(): GraphIR {
  return JSON.parse(readFileSync(routingFixturePath, "utf8")) as GraphIR;
}

test("updateNodeConfig({model}) keeps IR valid and flows through to agents.py", () => {
  const initial = cloneFixture(loadFixture());
  const original = compile(initial);
  const originalAgents = original.get("agents.py") ?? "";
  assert.ok(
    originalAgents.includes("gemini-flash-latest"),
    "fixture invariant: city-time uses gemini-flash-latest",
  );

  const next = applyNodeConfigPatch(initial, "n_city_gen", {
    model: "gemini-pro-latest",
  });

  // The reducer is pure: original is untouched.
  assert.notStrictEqual(next, initial);
  assert.strictEqual(initial.nodes[0]?.id, "n_city_gen");
  const initialAgent = initial.nodes[0];
  assert.ok(initialAgent && initialAgent.type === "agent");
  assert.strictEqual(initialAgent.config.model, "gemini-flash-latest");

  // The patched node carries the new model; other nodes are referentially equal.
  const patchedAgent = next.nodes[0];
  assert.ok(patchedAgent && patchedAgent.type === "agent");
  assert.strictEqual(patchedAgent.config.model, "gemini-pro-latest");
  assert.strictEqual(next.nodes[1], initial.nodes[1]);

  // Round-trip through the validator + codegen.
  const result = validate(next);
  assert.strictEqual(result.ok, true, `validate must stay clean: ${JSON.stringify(result.errors)}`);

  const project = compile(next);
  const agents = project.get("agents.py") ?? "";
  assert.ok(
    agents.includes("gemini-pro-latest"),
    "patched model must appear in agents.py",
  );

  // city_report still uses the original model — only n_city_gen was patched.
  const flashCount = (agents.match(/gemini-flash-latest/g) ?? []).length;
  const proCount = (agents.match(/gemini-pro-latest/g) ?? []).length;
  assert.strictEqual(flashCount, 1, "city_report still uses gemini-flash-latest");
  assert.strictEqual(proCount, 1, "patched city_generator uses gemini-pro-latest");
});

test("updateNodeConfig({model: ''}) surfaces a validation finding via compile", () => {
  const initial = cloneFixture(loadFixture());
  const broken = applyNodeConfigPatch(initial, "n_city_gen", { model: "" });
  const result = validate(broken);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.errors.some((f) => f.code === "AGENT_MISSING_MODEL"),
    `expected AGENT_MISSING_MODEL, got: ${result.errors.map((f) => f.code).join(", ")}`,
  );
});

// ---- Canvas topology slice (ADR-0026) -----------------------------------

test("store.deleteNode clears selectedNodeId when it matched the removed node", () => {
  const ir = cloneFixture(loadFixture());
  const store = createIRStore(ir);

  store.getState().setSelectedNode("n_lookup");
  assert.strictEqual(store.getState().selectedNodeId, "n_lookup");

  store.getState().deleteNode("n_lookup");

  assert.strictEqual(
    store.getState().selectedNodeId,
    null,
    "selection must clear when the selected node is deleted",
  );
  assert.ok(
    !store.getState().ir.nodes.some((n) => n.id === "n_lookup"),
    "node must be gone from the store IR",
  );

  // Deleting a different node leaves the (now-null) selection alone, and
  // deleting nothing leaves a non-matching selection alone.
  store.getState().setSelectedNode("n_city_gen");
  store.getState().deleteNode("n_done");
  assert.strictEqual(
    store.getState().selectedNodeId,
    "n_city_gen",
    "deleting a different node must not clear the selection",
  );
});

test("replaceIR swaps the entire IR and clears the selection", () => {
  const a = cloneFixture(loadFixture());
  const b = cloneFixture(loadRoutingFixture());
  const store = createIRStore(a);
  store.getState().setSelectedNode("n_city_gen");
  assert.strictEqual(store.getState().selectedNodeId, "n_city_gen");

  store.getState().replaceIR(b);

  assert.strictEqual(store.getState().ir, b, "store now holds the loaded IR");
  assert.strictEqual(
    store.getState().selectedNodeId,
    null,
    "selection clears — ids from the loaded IR don't match the previous graph",
  );
});

test("store.setNodePosition persists into the IR and Save IR round-trips positions", () => {
  const store = createIRStore(cloneFixture(loadFixture()));

  store.getState().setNodePosition("n_city_gen", 999, 333);
  const moved = store
    .getState()
    .ir.nodes.find((n) => n.id === "n_city_gen")!;
  assert.deepStrictEqual(moved.ui, { x: 999, y: 333 });

  // Mimic the Save IR round-trip — JSON.stringify ↔ JSON.parse — and
  // confirm the position survives. This is the gate against a future
  // change that, say, stops persisting `ui` to disk.
  const serialized = JSON.stringify(store.getState().ir);
  const roundTripped = JSON.parse(serialized) as typeof store.getState.prototype;
  const after = (roundTripped as GraphIR).nodes.find(
    (n) => n.id === "n_city_gen",
  )!;
  assert.deepStrictEqual(after.ui, { x: 999, y: 333 });
});

test("store.focusNode selects the node, clears edge selection, bumps the nonce (ADR-0043)", () => {
  const store = createIRStore(cloneFixture(loadFixture()));

  store.getState().setSelectedEdge({ from: "START", to: "n_city_gen" });
  store.getState().focusNode("n_city_gen");

  assert.strictEqual(store.getState().selectedNodeId, "n_city_gen");
  assert.strictEqual(store.getState().selectedEdge, null);
  const first = store.getState().focusRequest;
  assert.ok(first && first.nodeId === "n_city_gen");

  // Clicking the same finding again must re-request the focus: the nonce
  // bumps so the canvas effect re-fires even for an identical nodeId.
  store.getState().focusNode("n_city_gen");
  const second = store.getState().focusRequest;
  assert.ok(second && second.nonce === first.nonce + 1);
});
