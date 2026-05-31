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
import type { GraphIR } from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/index.ts";
import { applyNodeConfigPatch, cloneFixture } from "../src/store/irReducer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "ir",
  "fixtures",
  "city-time.ir.json",
);

function loadFixture(): GraphIR {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as GraphIR;
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
