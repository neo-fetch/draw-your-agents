/**
 * Pure reducer + bridge tests for the IR layer used by the inspector
 * (ADR-0022/0023/0028/0029). Lives under `apps/web/test/` so the default
 * install-free `npm test` gate (ADR-0011 / ADR-0013) keeps covering it.
 *
 * Store-action tests that require `createIRStore` (and therefore `zustand`)
 * live in the install-required tier at `apps/web/test-app/irStore.test.ts`
 * (ADR-0031 / ADR-0032).
 *
 * Runs under `node --test` against the native TS loader — no `npm install`,
 * no browser, no React tree.
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
  applyNodePosition,
  cloneFixture,
} from "../src/store/irReducer.ts";
import {
  editorStateToSegments,
  segmentsToEditorState,
} from "../src/inspector/segmentsBridge.ts";

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

// ---- applyNodePosition (ADR-0028) --------------------------------------

test("applyNodePosition writes node.ui.{x,y} and preserves sibling identity", () => {
  const ir = cloneFixture(loadFixture());
  const before = ir.nodes.find((n) => n.id === "n_city_gen")!;
  const beforeOthers = ir.nodes.filter((n) => n.id !== "n_city_gen");

  const next = applyNodePosition(ir, "n_city_gen", 480, 120);

  assert.notStrictEqual(next, ir, "position change yields a new IR object");
  const moved = next.nodes.find((n) => n.id === "n_city_gen")!;
  assert.deepStrictEqual(moved.ui, { x: 480, y: 120 });
  assert.notStrictEqual(moved, before, "the moved node is a fresh object");

  // Siblings preserve referential identity (the reducer doesn't recreate
  // them — important so RF doesn't re-render unaffected nodes).
  for (const n of beforeOthers) {
    const found = next.nodes.find((x) => x.id === n.id);
    assert.strictEqual(found, n, `sibling ${n.id} kept identity`);
  }
});

test("applyNodePosition no-ops (returns input ref) when the position is unchanged", () => {
  const ir = cloneFixture(loadFixture());
  const target = ir.nodes.find((n) => n.id === "n_city_gen")!;
  const { x, y } = target.ui!;

  const next = applyNodePosition(ir, "n_city_gen", x, y);
  assert.strictEqual(
    next,
    ir,
    "unchanged position must return the input IR ref (idle re-renders don't churn)",
  );
});

test("applyNodePosition no-ops when nodeId is unknown", () => {
  const ir = cloneFixture(loadFixture());
  const next = applyNodePosition(ir, "n_does_not_exist", 1, 2);
  assert.strictEqual(next, ir);
});

test("bridge-round-tripped instruction segments still validate + flow through to agents.py (ADR-0029)", () => {
  // The slice integration check: take the report agent's segments through
  // the editor bridge and back, dispatch via `updateNodeConfig`, and the
  // resulting IR must (a) validate clean and (b) still emit the codegen
  // source-bound form into agents.py. If a future bridge change drops or
  // mangles a chip, this fails loud.
  const ir = cloneFixture(loadFixture());
  const report = ir.nodes.find((n) => n.id === "n_report") as AgentNode;
  const original = report.config.instruction.segments;

  const roundTripped = editorStateToSegments(segmentsToEditorState(original));
  assert.deepStrictEqual(
    roundTripped,
    original,
    "city-time report round-trips identity through the bridge",
  );

  const patched = applyNodeConfigPatch(ir, "n_report", {
    instruction: { segments: roundTripped },
  });
  const result = validate(patched);
  assert.strictEqual(
    result.ok,
    true,
    `validate should be clean after bridge round-trip; got: ${JSON.stringify(result.findings)}`,
  );

  const agentsPy = compile(patched).get("agents.py") ?? "";
  assert.ok(
    agentsPy.includes("<CityTime.time_info from lookup_time>"),
    "codegen still emits source-bound chip after round-trip",
  );
  assert.ok(
    agentsPy.includes("<CityTime.city from lookup_time>"),
    "codegen still emits second chip after round-trip",
  );
});
