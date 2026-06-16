/**
 * Install-required store tests for `createTargetStore`. Lives in the
 * `test-app/` tier (ADR-0031/0032): the store imports `zustand` at runtime,
 * so this file cannot live under `apps/web/test/` without breaking the
 * install-free cold-checkout gate (ADR-0011 / ADR-0013).
 *
 * The registry itself is covered install-free in `test/targets.test.ts`.
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
import { compile } from "../../../packages/codegen/src/index.ts";
import { createTargetStore } from "../src/target/targetStore.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here, "..", "..", "..", "packages", "ir", "fixtures", "city-time.ir.json",
);

function loadFixture(): GraphIR {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as GraphIR;
}

test("fresh store: lands on the picker with the ADK default", () => {
  const store = createTargetStore();
  assert.equal(store.getState().phase, "landing");
  assert.equal(store.getState().target, "adk");
});

test("chooseTarget: picks the target and enters the builder", () => {
  const store = createTargetStore();
  store.getState().chooseTarget("langgraph");
  assert.equal(store.getState().phase, "builder");
  assert.equal(store.getState().target, "langgraph");
});

test("setTarget: flips the target without leaving the builder", () => {
  const store = createTargetStore();
  store.getState().chooseTarget("adk");
  store.getState().setTarget("langgraph");
  assert.equal(store.getState().phase, "builder");
  assert.equal(store.getState().target, "langgraph");
});

test("returnToLanding: back to the picker, target kept in-session", () => {
  const store = createTargetStore();
  store.getState().chooseTarget("langgraph");
  store.getState().returnToLanding();
  assert.equal(store.getState().phase, "landing");
  assert.equal(store.getState().target, "langgraph");
});

test("showBathory: opens the inspiration page, target untouched", () => {
  const store = createTargetStore();
  store.getState().chooseTarget("langgraph");
  store.getState().showBathory();
  assert.equal(store.getState().phase, "bathory");
  assert.equal(store.getState().target, "langgraph");
});

test("returnToLanding: backs out of the bathory page to the picker", () => {
  const store = createTargetStore();
  store.getState().showBathory();
  assert.equal(store.getState().phase, "bathory");
  store.getState().returnToLanding();
  assert.equal(store.getState().phase, "landing");
});

test("the store's target values drive distinct compile() outputs", () => {
  const ir = loadFixture();
  const adk = compile(ir, { target: "adk" });
  const langgraph = compile(ir, { target: "langgraph" });
  assert.ok(adk.has("workflow.py"), "ADK project carries workflow.py");
  assert.ok(!adk.has("graph.py"));
  assert.ok(langgraph.has("graph.py"), "LangGraph project carries graph.py");
  assert.ok(!langgraph.has("workflow.py"));
});
