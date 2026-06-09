/**
 * Headless tests for the clickable-finding resolver (ADR-0043).
 *
 * `resolveFindingTarget` maps a validator finding's `nodeId` to the top-level
 * canvas node a click should select: top-level ids resolve to themselves;
 * nested ids (`<parentId>/.../<nodeId>`, the validator's `pathPrefix`
 * composition) resolve to the enclosing top-level workflow node; anything
 * else is `null` (the finding renders as plain text).
 *
 * The store side (`focusNode` selecting + bumping the focus nonce) imports
 * zustand at runtime, so those assertions live in
 * `test-app/irStore.test.ts` (ADR-0031/0032 install-required tier).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { resolveFindingTarget } from "../src/store/findingTarget.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function loadFixture(name: string): GraphIR {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as GraphIR;
}

test("a top-level node id resolves to itself", () => {
  const ir = loadFixture("city-time.ir.json");
  assert.equal(resolveFindingTarget("n_city_gen", ir), "n_city_gen");
});

test("a real validator finding's nodeId resolves to a canvas node", () => {
  // Break the city-time graph: drop the agent's model so the validator emits
  // a node-scoped finding, then resolve that finding's actual nodeId.
  const ir = loadFixture("city-time.ir.json");
  const agent = ir.nodes.find((n) => n.id === "n_city_gen");
  assert.ok(agent && agent.type === "agent");
  delete (agent.config as Record<string, unknown>).model;
  const finding = validate(ir).errors.find((f) => f.nodeId);
  assert.ok(finding, "expected a node-scoped error finding");
  assert.equal(resolveFindingTarget(finding.nodeId, ir), "n_city_gen");
});

test("a nested finding resolves to the enclosing top-level workflow node", () => {
  // Break the nested fixture *inside* the sub-graph — drop the edge into
  // n_inner_b so it goes UNREACHABLE_NODE. The validator composes the
  // finding's nodeId as `<workflowNodeId>/<innerNodeId>` (pathPrefix).
  const ir = loadFixture("nested.ir.json");
  const wf = ir.nodes.find((n) => n.type === "workflow");
  assert.ok(wf && wf.type === "workflow");
  const graph = wf.config.graph;
  graph.edges = graph.edges.filter((e) => e.to !== "n_inner_b");
  const finding = validate(ir).errors.find(
    (f) => f.nodeId === `${wf.id}/n_inner_b`,
  );
  assert.ok(finding, "expected a nested-composed error finding");
  assert.equal(resolveFindingTarget(finding.nodeId, ir), wf.id);
});

test("undefined, unknown, and unknown-parent ids resolve to null", () => {
  const ir = loadFixture("city-time.ir.json");
  assert.equal(resolveFindingTarget(undefined, ir), null);
  assert.equal(resolveFindingTarget("no_such_node", ir), null);
  assert.equal(resolveFindingTarget("no_such_parent/inner", ir), null);
});
