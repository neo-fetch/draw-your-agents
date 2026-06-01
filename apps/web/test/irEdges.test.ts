/**
 * Headless test for the canvas-topology reducers (ADR-0026):
 * `connectEdge`, `deleteNode`, `deleteEdge`.
 *
 * Mirrors the cold-checkout posture of `addNode.test.ts` and
 * `irStore.test.ts` — runs under `node --test` against Node's native TS
 * loader, no `npm install`, no zustand, no React.
 *
 * The reducers exist to give the canvas a tested core for wiring +
 * deleting; this file is the regression oracle. The contracts pinned
 * below correspond one-to-one with the ADR-0026 decisions:
 *   - connect happy path adds an edge that validates clean and reaches codegen
 *   - guards (edge-to-START, duplicate, self-loop) return the input IR
 *   - deleteNode cascades to every edge referencing the node
 *   - deleteNode is top-level only (nested-graph editing is a later slice)
 *   - deleteEdge removes exactly the target pair
 *   - all three reducers are pure
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/index.ts";
import { cloneFixture } from "../src/store/irReducer.ts";
import { connectEdge, deleteEdge, deleteNode } from "../src/store/irEdges.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function loadCityTime(): GraphIR {
  return JSON.parse(
    readFileSync(join(fixturesDir, "city-time.ir.json"), "utf8"),
  ) as GraphIR;
}
function loadNested(): GraphIR {
  return JSON.parse(
    readFileSync(join(fixturesDir, "nested.ir.json"), "utf8"),
  ) as GraphIR;
}

// ---- connectEdge --------------------------------------------------------

test("connectEdge: happy path — wiring a missing edge clears UNREACHABLE_NODE and reaches codegen", () => {
  // Start from a city-time IR with the n_lookup→n_report edge removed.
  // That makes n_report (and n_done) unreachable, surfacing UNREACHABLE_NODE.
  const base = cloneFixture(loadCityTime());
  const broken: GraphIR = {
    ...base,
    edges: base.edges.filter(
      (e) => !(e.from === "n_lookup" && e.to === "n_report"),
    ),
  };
  const beforeResult = validate(broken);
  assert.ok(
    beforeResult.errors.some((f) => f.code === "UNREACHABLE_NODE"),
    `precondition: UNREACHABLE_NODE expected, got ${JSON.stringify(beforeResult.errors)}`,
  );

  const next = connectEdge(broken, "n_lookup", "n_report");

  assert.notStrictEqual(next, broken, "happy path returns a new IR object");
  assert.strictEqual(next.edges.length, broken.edges.length + 1);
  const added = next.edges[next.edges.length - 1]!;
  assert.deepStrictEqual(added, { from: "n_lookup", to: "n_report" });
  assert.strictEqual(added.route, undefined, "plain edges carry no route");

  // Validates clean now.
  const result = validate(next);
  assert.strictEqual(
    result.ok,
    true,
    `expected clean validate after wiring, got: ${JSON.stringify(result.errors)}`,
  );

  // Edge reaches codegen — workflow.py mentions lookup_time and city_report.
  const workflow = compile(next).get("workflow.py") ?? "";
  assert.ok(
    workflow.includes("lookup_time") && workflow.includes("city_report"),
    "lookup_time and city_report must appear in workflow.py after wiring",
  );
});

test("connectEdge: from === START is allowed", () => {
  const ir = cloneFixture(loadCityTime());
  // Use a fresh disconnected node so we don't introduce a duplicate START edge.
  const next = connectEdge(ir, "START", "n_report");
  assert.notStrictEqual(next, ir);
  assert.deepStrictEqual(next.edges[next.edges.length - 1], {
    from: "START",
    to: "n_report",
  });
});

test("connectEdge guard: to === START is a silent no-op (returns input IR)", () => {
  const ir = cloneFixture(loadCityTime());
  const next = connectEdge(ir, "n_lookup", "START");
  assert.strictEqual(next, ir, "no-op must return the same IR reference");
});

test("connectEdge guard: self-loop is a silent no-op", () => {
  const ir = cloneFixture(loadCityTime());
  const next = connectEdge(ir, "n_lookup", "n_lookup");
  assert.strictEqual(next, ir);
});

test("connectEdge guard: duplicate plain edge is a silent no-op", () => {
  // city-time already has n_city_gen → n_lookup as a plain edge.
  const ir = cloneFixture(loadCityTime());
  const next = connectEdge(ir, "n_city_gen", "n_lookup");
  assert.strictEqual(next, ir, "duplicating an existing plain edge must no-op");

  // And calling twice on a freshly-added pair: second call must no-op too.
  const broken: GraphIR = {
    ...ir,
    edges: ir.edges.filter(
      (e) => !(e.from === "n_lookup" && e.to === "n_report"),
    ),
  };
  const once = connectEdge(broken, "n_lookup", "n_report");
  const twice = connectEdge(once, "n_lookup", "n_report");
  assert.strictEqual(twice, once, "second identical connect must no-op");
});

// ---- deleteNode ---------------------------------------------------------

test("deleteNode: cascades to every edge referencing the node (both in and out)", () => {
  const ir = cloneFixture(loadCityTime());
  // n_lookup has an in-edge (n_city_gen → n_lookup) and an out-edge
  // (n_lookup → n_report). Removing it must drop both.
  const originalNodeCount = ir.nodes.length;
  const originalEdgeCount = ir.edges.length;

  const next = deleteNode(ir, "n_lookup");

  assert.notStrictEqual(next, ir);
  assert.strictEqual(next.nodes.length, originalNodeCount - 1);
  assert.strictEqual(
    next.edges.length,
    originalEdgeCount - 2,
    "both edges referencing n_lookup must be removed",
  );
  assert.ok(
    !next.nodes.some((n) => n.id === "n_lookup"),
    "node must be gone",
  );
  for (const e of next.edges) {
    assert.notStrictEqual(e.from, "n_lookup", "no dangling edge from n_lookup");
    assert.notStrictEqual(e.to, "n_lookup", "no dangling edge to n_lookup");
  }
});

test("deleteNode: unknown top-level id is a silent no-op", () => {
  const ir = cloneFixture(loadCityTime());
  const next = deleteNode(ir, "n_does_not_exist");
  assert.strictEqual(next, ir);
});

test("deleteNode: nested ids are not edited (top-level only this slice)", () => {
  // n_inner_a lives inside nested.ir.json's workflow.config.graph, not at
  // top level. The reducer must leave the IR untouched.
  const ir = cloneFixture(loadNested());
  const next = deleteNode(ir, "n_inner_a");
  assert.strictEqual(next, ir, "nested ids must return the input IR ref");
});

// ---- deleteEdge ---------------------------------------------------------

test("deleteEdge: removes exactly the target pair", () => {
  const ir = cloneFixture(loadCityTime());
  const originalEdgeCount = ir.edges.length;

  const next = deleteEdge(ir, "n_city_gen", "n_lookup");

  assert.notStrictEqual(next, ir);
  assert.strictEqual(next.edges.length, originalEdgeCount - 1);
  for (const e of next.edges) {
    assert.ok(
      !(e.from === "n_city_gen" && e.to === "n_lookup"),
      "target edge must be gone",
    );
  }
  // Other edges remain — spot-check the survivors.
  assert.ok(
    next.edges.some((e) => e.from === "START" && e.to === "n_city_gen"),
  );
  assert.ok(
    next.edges.some((e) => e.from === "n_lookup" && e.to === "n_report"),
  );
});

test("deleteEdge: non-existent pair is a silent no-op", () => {
  const ir = cloneFixture(loadCityTime());
  const next = deleteEdge(ir, "n_city_gen", "n_report");
  assert.strictEqual(next, ir);
});

// ---- Purity -------------------------------------------------------------

test("reducers are pure: input arrays untouched, sibling nodes referentially equal", () => {
  const ir = cloneFixture(loadCityTime());
  const beforeNodes = ir.nodes;
  const beforeEdges = ir.edges;
  const node0 = ir.nodes[0];
  const edge0 = ir.edges[0];

  const a = connectEdge(ir, "START", "n_report");
  const b = deleteEdge(ir, "n_city_gen", "n_lookup");
  const c = deleteNode(ir, "n_lookup");

  assert.strictEqual(ir.nodes, beforeNodes, "input nodes array untouched");
  assert.strictEqual(ir.edges, beforeEdges, "input edges array untouched");
  assert.strictEqual(ir.nodes[0], node0);
  assert.strictEqual(ir.edges[0], edge0);

  // The three returned IRs share their unchanged nodes with the input.
  for (let i = 0; i < ir.nodes.length; i++) {
    assert.strictEqual(a.nodes[i], ir.nodes[i], `connectEdge: sibling ${i} preserved`);
    assert.strictEqual(b.nodes[i], ir.nodes[i], `deleteEdge: sibling ${i} preserved`);
  }
  // deleteNode drops one node — the surviving ones keep identity.
  const survivors = c.nodes;
  for (const surv of survivors) {
    const original = ir.nodes.find((n) => n.id === surv.id)!;
    assert.strictEqual(surv, original, "deleteNode: surviving siblings preserved");
  }
});
