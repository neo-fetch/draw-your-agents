/**
 * Headless test for the `insertVariable` pure helper (ADR-0030).
 *
 * The slice's IR-layer oracle: appending a `VarSegment` + auto-wiring
 * `inputSchemaRef` must produce IR that validates clean AND emits the
 * source-bound chip through codegen. If a future change drops the auto-wire
 * or mangles the segment, this fails loud.
 *
 * Runs under `node --test` against the native TS loader with no
 * `npm install` (ADR-0011 / ADR-0013), alongside the rest of the install-free
 * reducer family.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentNode, GraphIR } from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/index.ts";
import { cloneFixture } from "../src/store/irReducer.ts";
import { insertVariable } from "../src/store/insertVariable.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");
const cityTimePath = join(fixturesDir, "city-time.ir.json");

function loadCityTime(): GraphIR {
  return JSON.parse(readFileSync(cityTimePath, "utf8")) as GraphIR;
}

/**
 * Reset n_report to a chip-free baseline so we can observe the auto-wire of
 * `inputSchemaRef` from `null` → `"CityTime"` on the first insert. The rest
 * of the graph (edges, the lookup_time producer) is left untouched.
 */
function withClearedReport(ir: GraphIR): GraphIR {
  const nodes = ir.nodes.map((n) => {
    if (n.id !== "n_report" || n.type !== "agent") return n;
    return {
      ...n,
      config: {
        ...n.config,
        instruction: { segments: [{ type: "text", value: "Report: " }] },
        inputSchemaRef: null,
      },
    } as AgentNode;
  });
  return { ...ir, nodes };
}

test("insertVariable on a sensible case validates + reaches agents.py", () => {
  const ir = withClearedReport(cloneFixture(loadCityTime()));

  const next = insertVariable(ir, "n_report", {
    source: "lookup_time",
    schema: "CityTime",
    field: "time_info",
  });

  const result = validate(next);
  assert.strictEqual(
    result.ok,
    true,
    `validate must stay clean: ${JSON.stringify(result.errors)}`,
  );

  const agentsPy = compile(next).get("agents.py") ?? "";
  assert.ok(
    agentsPy.includes("<CityTime.time_info from lookup_time>"),
    "codegen must emit the source-bound chip string",
  );
});

test("insertVariable auto-wires inputSchemaRef when previously null", () => {
  const ir = withClearedReport(cloneFixture(loadCityTime()));
  const before = ir.nodes.find((n) => n.id === "n_report") as AgentNode;
  assert.strictEqual(before.config.inputSchemaRef, null);

  const next = insertVariable(ir, "n_report", {
    source: "lookup_time",
    schema: "CityTime",
    field: "city",
  });
  const after = next.nodes.find((n) => n.id === "n_report") as AgentNode;
  assert.strictEqual(after.config.inputSchemaRef, "CityTime");

  // Segment was appended after the existing "Report: " text segment.
  const segs = after.config.instruction.segments;
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual(segs[1], {
    type: "var",
    schema: "CityTime",
    field: "city",
    source: "lookup_time",
  });
});

test("insertVariable leaves inputSchemaRef alone when already equal", () => {
  // Pre-set inputSchemaRef to the target schema; the helper must not touch
  // it — this matters because the React inspector dropdown shouldn't see a
  // spurious "change" event on every chip insert.
  const ir = cloneFixture(loadCityTime());
  const reportBefore = ir.nodes.find((n) => n.id === "n_report") as AgentNode;
  assert.strictEqual(reportBefore.config.inputSchemaRef, "CityTime");

  const next = insertVariable(ir, "n_report", {
    source: "lookup_time",
    schema: "CityTime",
    field: "time_info",
  });
  const reportAfter = next.nodes.find((n) => n.id === "n_report") as AgentNode;
  assert.strictEqual(reportAfter.config.inputSchemaRef, "CityTime");
});

test("insertVariable is pure — original IR + sibling nodes preserve identity", () => {
  const ir = withClearedReport(cloneFixture(loadCityTime()));
  const before = ir.nodes.find((n) => n.id === "n_report") as AgentNode;
  const beforeSiblings = ir.nodes.filter((n) => n.id !== "n_report");

  const next = insertVariable(ir, "n_report", {
    source: "lookup_time",
    schema: "CityTime",
    field: "time_info",
  });

  assert.notStrictEqual(next, ir, "new IR reference");
  // Original is untouched.
  assert.strictEqual(before.config.instruction.segments.length, 1);
  assert.strictEqual(before.config.inputSchemaRef, null);

  // Siblings preserve referential identity (RF doesn't re-render unaffected nodes).
  for (const sib of beforeSiblings) {
    const found = next.nodes.find((n) => n.id === sib.id);
    assert.strictEqual(found, sib, `sibling ${sib.id} kept identity`);
  }
});

test("insertVariable is a no-op for an unknown node id", () => {
  const ir = cloneFixture(loadCityTime());
  const next = insertVariable(ir, "n_does_not_exist", {
    source: "lookup_time",
    schema: "CityTime",
    field: "time_info",
  });
  assert.strictEqual(next, ir, "unknown agentId returns the input IR ref");
});

test("insertVariable is a no-op for a non-agent node", () => {
  const ir = cloneFixture(loadCityTime());
  // n_lookup is a function, not an agent.
  const next = insertVariable(ir, "n_lookup", {
    source: "lookup_time",
    schema: "CityTime",
    field: "time_info",
  });
  assert.strictEqual(next, ir, "non-agent target returns the input IR ref");
});
