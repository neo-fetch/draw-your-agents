/**
 * Headless oracle for the `renameNode` pure reducer (ADR-0036).
 *
 * Node analog of ADR-0035's `renameSchema` test suite. Pins the cascade:
 * renaming a producer rewrites every consumer agent's var-segment `source`
 * and every agent `tools[]` entry that referenced the old name, while edges
 * (id-keyed) are left alone. Install-free per ADR-0011 / ADR-0013 / ADR-0022
 * / ADR-0032: only IR types, the validator, codegen, and Node builtins.
 *
 * Top-level only — nested `workflow.config.graph.nodes` rename is out of
 * scope, mirroring the nested-graph editing deferral across
 * ADR-0017 / ADR-0023 / ADR-0026 / ADR-0029 / ADR-0035.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  AgentNode,
  FunctionNode,
  GraphIR,
  ToolNode,
  VarSegment,
} from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/index.ts";
import { cloneFixture, renameNode } from "../src/store/irReducer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function loadCityTime(): GraphIR {
  return JSON.parse(
    readFileSync(join(fixturesDir, "city-time.ir.json"), "utf8"),
  ) as GraphIR;
}

// --- producer rename cascades into consumer var chips --------------------

test("renameNode cascades a producer rename into every var-chip source + validates + reaches codegen", () => {
  // city-time wires `lookup_time` → `city_report`, whose prompt has two var
  // chips with source="lookup_time". Renaming the producer must (a) update
  // both chips, (b) keep the IR clean, (c) emit the new source-bound form.
  const ir = cloneFixture(loadCityTime());
  const next = renameNode(ir, "n_lookup", "fetch_time");

  // (1) target node renamed
  const lookup = next.nodes.find((n) => n.id === "n_lookup") as FunctionNode;
  assert.strictEqual(lookup.name, "fetch_time");

  // (2) both chips on city_report cascaded
  const report = next.nodes.find((n) => n.id === "n_report") as AgentNode;
  const chips = report.config.instruction.segments.filter(
    (s) => s.type === "var",
  ) as VarSegment[];
  assert.ok(chips.length >= 2, "city-time fixture seeds multiple chips");
  for (const c of chips) assert.strictEqual(c.source, "fetch_time");

  // (3) validates clean — no dangling refs anywhere
  const result = validate(next);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));

  // (4) codegen emits the new source-bound form, no stale references
  const agentsPy = compile(next).get("agents.py") ?? "";
  assert.ok(
    agentsPy.includes("<CityTime.time_info from fetch_time>"),
    "renamed producer reaches the rendered prompt",
  );
  assert.ok(
    agentsPy.includes("<CityTime.city from fetch_time>"),
    "second chip also updated",
  );
  assert.ok(
    !agentsPy.includes("from lookup_time>"),
    "no stale lookup_time reference in agents.py",
  );
});

// --- tools[] cascade ------------------------------------------------------

test("renameNode cascades into agent config.tools[] entries", () => {
  // Construct a derived IR: city-time + a tool node + an agent that lists the
  // tool by name in `config.tools[]`. Renaming the tool must rewrite the
  // agent's tools entry; the unrelated tools entry must survive untouched.
  const base = cloneFixture(loadCityTime());
  const toolNode: ToolNode = {
    id: "n_tool",
    type: "tool",
    name: "fetch_data",
    config: {
      description: "test tool",
      inputType: "str",
      outputType: "str",
      body: null,
    },
  };
  const derived: GraphIR = {
    ...base,
    nodes: base.nodes
      .map((n) => {
        if (n.id === "n_city_gen" && n.type === "agent") {
          return {
            ...n,
            config: { ...n.config, tools: ["fetch_data", "other_tool"] },
          };
        }
        return n;
      })
      .concat([toolNode]),
  };

  const next = renameNode(derived, "n_tool", "load_data");

  const tool = next.nodes.find((n) => n.id === "n_tool") as ToolNode;
  assert.strictEqual(tool.name, "load_data");

  const agent = next.nodes.find((n) => n.id === "n_city_gen") as AgentNode;
  assert.deepStrictEqual(
    agent.config.tools,
    ["load_data", "other_tool"],
    "matching entry rewrites; unrelated entries pass through unchanged",
  );
});

// --- no-op cases ----------------------------------------------------------

test("renameNode is a no-op when newName === oldName", () => {
  const ir = cloneFixture(loadCityTime());
  const next = renameNode(ir, "n_lookup", "lookup_time");
  assert.strictEqual(next, ir, "returns the same IR reference");
});

test("renameNode is a no-op when nodeId is unknown", () => {
  const ir = cloneFixture(loadCityTime());
  const next = renameNode(ir, "n_does_not_exist", "whatever");
  assert.strictEqual(next, ir);
});

// --- purity ---------------------------------------------------------------

test("renameNode preserves sibling node identity and leaves input IR untouched", () => {
  const ir = cloneFixture(loadCityTime());
  const cityGen = ir.nodes.find((n) => n.id === "n_city_gen")!;
  const done = ir.nodes.find((n) => n.id === "n_done")!;
  // city_report references lookup_time via chips → it MUST be recreated.
  const report = ir.nodes.find((n) => n.id === "n_report")!;

  const next = renameNode(ir, "n_lookup", "fetch_time");

  // original IR untouched
  const origLookup = ir.nodes.find((n) => n.id === "n_lookup") as FunctionNode;
  assert.strictEqual(origLookup.name, "lookup_time");

  // unaffected siblings keep referential identity (no React Flow churn)
  assert.strictEqual(
    next.nodes.find((n) => n.id === "n_city_gen"),
    cityGen,
    "city_generator has no reference to lookup_time → identity preserved",
  );
  assert.strictEqual(
    next.nodes.find((n) => n.id === "n_done"),
    done,
    "completed_message has no reference to lookup_time → identity preserved",
  );

  // city_report referenced the renamed producer → MUST be a fresh object
  assert.notStrictEqual(
    next.nodes.find((n) => n.id === "n_report"),
    report,
    "city_report cascades and must be a fresh object",
  );
});
