/**
 * Spec tests for the authoritative IR validator (ADR-0013). The fixtures are the
 * spec: city-time is a well-formed IR (zero errors); broken-var-and-graph is a
 * deliberately invalid IR whose specific finding *codes* are asserted (not just
 * "throws"). Runs on Node's native TypeScript support — no build step (ADR-0011).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GraphIR } from "../src/types.ts";
import { validate, ValidationCode } from "../src/validate.ts";

function loadIR(rel: string): GraphIR {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as GraphIR;
}

test("city-time fixture validates with zero errors", () => {
  const r = validate(loadIR("../fixtures/city-time.ir.json"));
  assert.deepEqual(r.errors, [], `unexpected errors: ${JSON.stringify(r.errors, null, 2)}`);
  assert.equal(r.ok, true);
});

test("broken-var-and-graph fixture reports the expected error codes", () => {
  const r = validate(loadIR("../fixtures/invalid/broken-var-and-graph.ir.json"));
  assert.equal(r.ok, false);

  const codes = new Set(r.errors.map((f) => f.code));
  const expected = [
    ValidationCode.VAR_SOURCE_NOT_STRUCTURED, // city_generator outputs "str", not a schema
    ValidationCode.VAR_FIELD_NOT_FOUND, // CityTime has no field "time_info"
    ValidationCode.VAR_INPUT_SCHEMA_MISMATCH, // inputSchemaRef is null, not "CityTime"
    ValidationCode.FUNCTION_UNKNOWN_OUTPUT_TYPE, // orphan.outputType "Mystery" is undeclared
    ValidationCode.UNREACHABLE_NODE, // n_orphan has no incoming edge
  ];
  for (const code of expected) {
    assert.ok(codes.has(code), `expected error code ${code}; got: ${[...codes].sort().join(", ")}`);
  }
});

test("findings carry nodeId for node-scoped problems", () => {
  const r = validate(loadIR("../fixtures/invalid/broken-var-and-graph.ir.json"));
  const orphan = r.errors.find((f) => f.code === ValidationCode.UNREACHABLE_NODE);
  assert.equal(orphan?.nodeId, "n_orphan");
});

test("parallel fixture validates with zero errors and zero warnings", () => {
  const r = validate(loadIR("../fixtures/parallel.ir.json"));
  assert.deepEqual(r.errors, [], `unexpected errors: ${JSON.stringify(r.errors, null, 2)}`);
  assert.deepEqual(r.warnings, [], `unexpected warnings: ${JSON.stringify(r.warnings, null, 2)}`);
  assert.equal(r.ok, true);
});

test("join-missing-failsafe fixture produces the warning, no errors", () => {
  const r = validate(loadIR("../fixtures/invalid/join-missing-failsafe.ir.json"));
  assert.equal(r.ok, true, "should have no errors (ok = true)");
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1, `expected exactly 1 warning, got ${r.warnings.length}`);
  const w = r.warnings[0];
  assert.equal(w.code, ValidationCode.JOIN_MISSING_FAILSAFE);
  assert.equal(w.nodeId, "n_risky_fn");
  assert.equal(w.severity, "warning");
});
