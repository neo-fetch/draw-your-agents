/**
 * Headless reducer test for the IR store (ADR-0022).
 *
 * The UI has no golden oracle, so this test pins the round-trip the slice was
 * built to prove: apply `updateNodeConfig` to the in-memory IR, and the
 * mutation must (a) keep the IR valid and (b) flow through `compile()` into
 * the generated `agents.py`. If a later inspector edit silently breaks this
 * contract, the test fails loud.
 *
 * Runs under `node --test` against the native TS loader — no `npm install`,
 * no browser, no React tree. The store's pure reducer is in `irReducer.ts`
 * specifically so this file can exercise it without pulling in `zustand`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentNode, FunctionNode, GraphIR, RouterNode } from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/index.ts";
import {
  applyModelParamPatch,
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

// ---- Widened inspector surface (ADR-0023) -------------------------------

test("applyModelParamPatch adds + preserves siblings, clears one key, drops the field when empty", () => {
  const initial = cloneFixture(loadFixture());

  // 1) Add temperature
  const t1 = applyModelParamPatch(initial, "n_city_gen", "temperature", 0.7);
  const a1 = t1.nodes[0] as AgentNode;
  assert.deepStrictEqual(a1.config.modelParams, { temperature: 0.7 });

  // 2) Add topP without clobbering temperature
  const t2 = applyModelParamPatch(t1, "n_city_gen", "topP", 0.9);
  const a2 = t2.nodes[0] as AgentNode;
  assert.deepStrictEqual(a2.config.modelParams, { temperature: 0.7, topP: 0.9 });

  // 3) Clear temperature — topP survives
  const t3 = applyModelParamPatch(t2, "n_city_gen", "temperature", undefined);
  const a3 = t3.nodes[0] as AgentNode;
  assert.deepStrictEqual(a3.config.modelParams, { topP: 0.9 });

  // 4) Clear topP — modelParams is removed entirely (not left as {})
  const t4 = applyModelParamPatch(t3, "n_city_gen", "topP", undefined);
  const a4 = t4.nodes[0] as AgentNode;
  assert.strictEqual(
    "modelParams" in a4.config,
    false,
    "empty modelParams must be absent from config, not an empty object",
  );

  // Purity: initial was never mutated; sibling nodes are referentially equal.
  const a0 = initial.nodes[0] as AgentNode;
  assert.strictEqual(a0.config.modelParams, undefined);
  assert.strictEqual(t2.nodes[1], initial.nodes[1]);

  // Validates clean; the param flows through codegen.
  const result = validate(t2);
  assert.strictEqual(result.ok, true, `validate must stay clean: ${JSON.stringify(result.errors)}`);
  const agents = compile(t2).get("agents.py") ?? "";
  assert.ok(
    /temperature\s*=\s*0\.7/.test(agents),
    "patched temperature must appear in agents.py",
  );
  assert.ok(
    /top_p\s*=\s*0\.9/.test(agents),
    "patched topP must appear in agents.py (snake_case kwarg per ADR-0012)",
  );
});

test("applyNodeConfigPatch on a function outputType flows through codegen", () => {
  const initial = cloneFixture(loadFixture());
  // n_done is the trailing function (inputType=str, outputType=str). Nothing
  // downstream consumes its output, so changing outputType to a declared
  // schema keeps the IR valid.
  const next = applyNodeConfigPatch(initial, "n_done", { outputType: "CityTime" });

  const fn = next.nodes[3] as FunctionNode;
  assert.strictEqual(fn.config.outputType, "CityTime");

  const result = validate(next);
  assert.strictEqual(result.ok, true, `validate must stay clean: ${JSON.stringify(result.errors)}`);

  const functions = compile(next).get("functions.py") ?? "";
  assert.ok(
    /completed_message\([^)]*\)\s*->\s*Event/.test(functions),
    "completed_message function signature still present",
  );
  assert.ok(
    /CityTime/.test(functions),
    "new outputType reference must reach functions.py",
  );
});

test("applyNodeConfigPatch on router.routes — matched routes validate, mismatched routes surface findings", () => {
  const initial = cloneFixture(loadRoutingFixture());

  // 1) Renaming a route without updating the corresponding edge label
  //    trips invariants 7 (ROUTER_ROUTE_NO_TARGET + ROUTER_EDGE_ROUTE_UNDECLARED).
  const broken = applyNodeConfigPatch(initial, "n_router", {
    routes: ["BUG", "CUSTOMER_SUPPORT", "FINANCE"], // LOGISTICS removed
  });
  const brokenResult = validate(broken);
  assert.strictEqual(brokenResult.ok, false);
  const codes = brokenResult.errors.map((f) => f.code);
  assert.ok(
    codes.includes("ROUTER_ROUTE_NO_TARGET"),
    `expected ROUTER_ROUTE_NO_TARGET, got: ${codes.join(", ")}`,
  );
  assert.ok(
    codes.includes("ROUTER_EDGE_ROUTE_UNDECLARED"),
    `expected ROUTER_EDGE_ROUTE_UNDECLARED, got: ${codes.join(", ")}`,
  );

  // 2) Reordering the existing routes keeps the IR clean and reaches codegen
  //    in the new declared order (ADR-0014: route map entries follow routes[]).
  const reordered = applyNodeConfigPatch(initial, "n_router", {
    routes: ["LOGISTICS", "BUG", "CUSTOMER_SUPPORT"],
  });
  const okResult = validate(reordered);
  assert.strictEqual(okResult.ok, true, `validate must stay clean: ${JSON.stringify(okResult.errors)}`);

  const router = reordered.nodes[1] as RouterNode;
  assert.deepStrictEqual(router.config.routes, ["LOGISTICS", "BUG", "CUSTOMER_SUPPORT"]);
  const workflow = compile(reordered).get("workflow.py") ?? "";
  // The route map should now list LOGISTICS first.
  const logisticsIdx = workflow.indexOf('"LOGISTICS"');
  const bugIdx = workflow.indexOf('"BUG"');
  assert.ok(logisticsIdx > 0 && bugIdx > 0, "both route keys must appear in workflow.py");
  assert.ok(
    logisticsIdx < bugIdx,
    "reordered router.routes must drive route-map entry order in workflow.py",
  );

  // Purity: original IR is untouched.
  const origRouter = initial.nodes[1] as RouterNode;
  assert.deepStrictEqual(origRouter.config.routes, ["BUG", "CUSTOMER_SUPPORT", "LOGISTICS"]);
});

// ---- Save / load slice (ADR-0024) ---------------------------------------

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
