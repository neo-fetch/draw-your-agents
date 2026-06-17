/**
 * Headless test for the non-adjacent (session-`state`) variable helpers
 * (ADR-0051): `insertStateVariable` + `stateCandidateVariables`.
 *
 * The IR-layer oracle for the second variable category: inserting a state chip
 * must (a) append a `via: "state"` segment WITHOUT touching `inputSchemaRef`,
 * (b) produce IR that validates clean, and (c) emit the `{Schema.field}` ADK
 * session form through codegen. The candidate helper must offer only ancestors
 * and lift the single-schema rail.
 *
 * Runs under `node --test` with no `npm install` (ADR-0011 / ADR-0013).
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
import {
  insertStateVariable,
  stateCandidateVariables,
} from "../src/store/insertVariable.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function loadStateVars(): GraphIR {
  return JSON.parse(
    readFileSync(join(fixturesDir, "state-vars.ir.json"), "utf8"),
  ) as GraphIR;
}

/** Drop summarize's existing state chip so we can re-insert it via the helper. */
function withClearedStateChip(ir: GraphIR): GraphIR {
  const nodes = ir.nodes.map((n) => {
    if (n.id !== "n_summarize" || n.type !== "agent") return n;
    return {
      ...n,
      config: {
        ...n.config,
        instruction: {
          segments: n.config.instruction.segments.filter(
            (s) => !(s.type === "var" && s.via === "state"),
          ),
        },
      },
    } as AgentNode;
  });
  return { ...ir, nodes };
}

test("insertStateVariable appends a via:state segment and leaves inputSchemaRef untouched", () => {
  const ir = withClearedStateChip(cloneFixture(loadStateVars()));
  const before = ir.nodes.find((n) => n.id === "n_summarize") as AgentNode;
  assert.equal(before.config.inputSchemaRef, "Expanded");

  const next = insertStateVariable(ir, "n_summarize", {
    source: "analyze",
    schema: "Analysis",
    field: "key_point",
  });

  const agent = next.nodes.find((n) => n.id === "n_summarize") as AgentNode;
  const last = agent.config.instruction.segments.at(-1);
  assert.deepEqual(last, {
    type: "var",
    schema: "Analysis",
    field: "key_point",
    source: "analyze",
    via: "state",
  });
  // The single-schema rail must NOT engage: positional input stays "Expanded".
  assert.equal(agent.config.inputSchemaRef, "Expanded");
});

test("inserted state variable validates clean and reaches agents.py as {Schema.field}", () => {
  const ir = withClearedStateChip(cloneFixture(loadStateVars()));
  const next = insertStateVariable(ir, "n_summarize", {
    source: "analyze",
    schema: "Analysis",
    field: "key_point",
  });

  const r = validate(next);
  assert.deepEqual(r.errors, [], `unexpected errors: ${JSON.stringify(r.errors, null, 2)}`);

  const files = compile(next);
  const agents = files.get("agents.py") ?? "";
  assert.match(agents, /\{Analysis\.key_point\}/);
});

test("stateCandidateVariables offers only ancestors and lifts the single-schema rail", () => {
  const ir = withClearedStateChip(cloneFixture(loadStateVars()));
  const cands = stateCandidateVariables(ir, "n_summarize");
  const sources = new Set(cands.map((c) => c.source));

  // Both analyze (grandparent) and expand (parent) are ancestors of summarize.
  assert.ok(sources.has("analyze"), "expected the non-adjacent ancestor 'analyze'");
  assert.ok(sources.has("expand"), "expected the adjacent ancestor 'expand'");
  // summarize never offers itself.
  assert.ok(!sources.has("summarize"));
  // Candidates span MORE than one schema — no single-schema rail.
  const schemas = new Set(cands.map((c) => c.schema));
  assert.ok(schemas.size >= 2, `expected multiple schemas, got: ${[...schemas].join(", ")}`);
});

test("stateCandidateVariables excludes non-ancestors (parallel siblings)", () => {
  // analyze and a fresh sibling both fan out from START — the sibling is not an
  // ancestor of analyze, so it must not be offered as a state source.
  const base = cloneFixture(loadStateVars());
  const sibling = {
    id: "n_sibling",
    type: "agent",
    name: "sibling",
    config: {
      model: "gemini-flash-latest",
      instruction: { segments: [{ type: "text", value: "x" }] },
      inputSchemaRef: null,
      outputSchemaRef: "Summary",
    },
  } as AgentNode;
  const ir: GraphIR = {
    ...base,
    nodes: [...base.nodes, sibling],
    edges: [...base.edges, { from: "START", to: "n_sibling" }],
  };
  const cands = stateCandidateVariables(ir, "n_analyze");
  assert.equal(cands.length, 0, "analyze has no ancestors, so no state candidates");
});