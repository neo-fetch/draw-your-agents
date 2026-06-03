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

test("human-input fixture validates with zero errors and zero warnings", () => {
  const r = validate(loadIR("../fixtures/human-input.ir.json"));
  assert.deepEqual(r.errors, [], `unexpected errors: ${JSON.stringify(r.errors, null, 2)}`);
  assert.deepEqual(r.warnings, [], `unexpected warnings: ${JSON.stringify(r.warnings, null, 2)}`);
  assert.equal(r.ok, true);
});

test("tool fixture validates with zero errors and zero warnings", () => {
  const r = validate(loadIR("../fixtures/tool.ir.json"));
  assert.deepEqual(r.errors, [], `unexpected errors: ${JSON.stringify(r.errors, null, 2)}`);
  assert.deepEqual(r.warnings, [], `unexpected warnings: ${JSON.stringify(r.warnings, null, 2)}`);
  assert.equal(r.ok, true);
});

test("tool node with bad type refs emits TOOL_UNKNOWN_INPUT/OUTPUT_TYPE", () => {
  const ir = {
    irVersion: "0.1.0",
    name: "bad_tool",
    schemas: [],
    nodes: [
      {
        id: "n_tool",
        type: "tool",
        name: "fetch",
        config: { inputType: "Mystery", outputType: "AlsoMystery", body: null },
      },
    ],
    edges: [{ from: "START", to: "n_tool" }],
  } as unknown as GraphIR;
  const r = validate(ir);
  const codes = new Set(r.errors.map((f) => f.code));
  assert.ok(codes.has(ValidationCode.TOOL_UNKNOWN_INPUT_TYPE));
  assert.ok(codes.has(ValidationCode.TOOL_UNKNOWN_OUTPUT_TYPE));
});

test("human-input-bad-ref fixture reports both UNKNOWN_HUMANINPUT_* codes on the same node", () => {
  const r = validate(loadIR("../fixtures/invalid/human-input-bad-ref.ir.json"));
  assert.equal(r.ok, false);
  const codes = new Set(r.errors.map((f) => f.code));
  assert.ok(codes.has(ValidationCode.UNKNOWN_HUMANINPUT_PAYLOAD_REF));
  assert.ok(codes.has(ValidationCode.UNKNOWN_HUMANINPUT_RESPONSE_SCHEMA_REF));
  for (const code of [
    ValidationCode.UNKNOWN_HUMANINPUT_PAYLOAD_REF,
    ValidationCode.UNKNOWN_HUMANINPUT_RESPONSE_SCHEMA_REF,
  ]) {
    const f = r.errors.find((e) => e.code === code);
    assert.equal(f?.nodeId, "n_ask");
  }
});

// -- nested workflow recursion (ADR-0017) --

test("nested fixture validates with zero errors and zero warnings", () => {
  const r = validate(loadIR("../fixtures/nested.ir.json"));
  assert.deepEqual(r.errors, [], `unexpected errors: ${JSON.stringify(r.errors, null, 2)}`);
  assert.deepEqual(r.warnings, [], `unexpected warnings: ${JSON.stringify(r.warnings, null, 2)}`);
  assert.equal(r.ok, true);
});

test("showcase-all-nodes fixture (every node type) validates with zero errors and zero warnings", () => {
  const r = validate(loadIR("../fixtures/showcase-all-nodes.ir.json"));
  assert.deepEqual(r.errors, [], `unexpected errors: ${JSON.stringify(r.errors, null, 2)}`);
  assert.deepEqual(r.warnings, [], `unexpected warnings: ${JSON.stringify(r.warnings, null, 2)}`);
  assert.equal(r.ok, true);
});

test("workflow node missing config.graph emits WORKFLOW_MISSING_GRAPH", () => {
  const ir = {
    irVersion: "0.1.0",
    name: "missing_graph",
    schemas: [],
    nodes: [{ id: "w", type: "workflow", name: "nested", config: {} }],
    edges: [{ from: "START", to: "w" }],
  } as unknown as GraphIR;
  const r = validate(ir);
  assert.equal(r.ok, false);
  const f = r.errors.find((e) => e.code === ValidationCode.WORKFLOW_MISSING_GRAPH);
  assert.ok(f, "expected WORKFLOW_MISSING_GRAPH finding");
  assert.equal(f!.nodeId, "w");
});

test("nested sub-IR findings are located with a parent-id path prefix", () => {
  // Sub-graph references a non-existent schema → FUNCTION_UNKNOWN_OUTPUT_TYPE on
  // n_inner; finding's nodeId should be "n_outer/n_inner" (ADR-0017).
  const ir = {
    irVersion: "0.1.0",
    name: "outer",
    schemas: [],
    nodes: [
      {
        id: "n_outer",
        type: "workflow",
        name: "outer_nested",
        config: {
          graph: {
            irVersion: "0.1.0",
            name: "inner",
            schemas: [],
            nodes: [
              {
                id: "n_inner",
                type: "function",
                name: "inner_fn",
                config: { inputType: "str", outputType: "Mystery", body: null },
              },
            ],
            edges: [{ from: "START", to: "n_inner" }],
          },
        },
      },
    ],
    edges: [{ from: "START", to: "n_outer" }],
  } as unknown as GraphIR;
  const r = validate(ir);
  const f = r.errors.find((e) => e.code === ValidationCode.FUNCTION_UNKNOWN_OUTPUT_TYPE);
  assert.ok(f, "expected FUNCTION_UNKNOWN_OUTPUT_TYPE from the nested sub-graph");
  assert.equal(f!.nodeId, "n_outer/n_inner");
});

test("duplicate node name across parent + nested levels fires DUPLICATE_NODE_NAME", () => {
  // The flat global namespace (ADR-0017): parent has a function named `shared`;
  // a nested sub-graph reuses the same name → flagged at the child.
  const ir = {
    irVersion: "0.1.0",
    name: "outer",
    schemas: [],
    nodes: [
      {
        id: "n_shared_parent",
        type: "function",
        name: "shared",
        config: { inputType: "str", outputType: "str", body: null },
      },
      {
        id: "n_outer",
        type: "workflow",
        name: "outer_nested",
        config: {
          graph: {
            irVersion: "0.1.0",
            name: "inner",
            schemas: [],
            nodes: [
              {
                id: "n_shared_child",
                type: "function",
                name: "shared",
                config: { inputType: "str", outputType: "str", body: null },
              },
            ],
            edges: [{ from: "START", to: "n_shared_child" }],
          },
        },
      },
    ],
    edges: [
      { from: "START", to: "n_shared_parent" },
      { from: "n_shared_parent", to: "n_outer" },
    ],
  } as unknown as GraphIR;
  const r = validate(ir);
  const f = r.errors.find((e) => e.code === ValidationCode.DUPLICATE_NODE_NAME);
  assert.ok(f, "expected DUPLICATE_NODE_NAME across nesting levels");
  assert.equal(f!.nodeId, "n_outer/n_shared_child");
});
