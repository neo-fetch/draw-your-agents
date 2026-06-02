/**
 * Headless test for the palette's pure candidate logic (ADR-0030).
 *
 * The slice's UI palette is a thin shell over `candidateVariables` +
 * `upstreamProducers`; this file pins the rules so the React layer stays
 * trivial. Runs install-free under `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentNode, FunctionNode, GraphIR } from "@graphical-agents/ir";
import { cloneFixture } from "../src/store/irReducer.ts";
import {
  candidateVariables,
  upstreamProducers,
} from "../src/store/insertVariable.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");
const cityTimePath = join(fixturesDir, "city-time.ir.json");

function loadCityTime(): GraphIR {
  return JSON.parse(readFileSync(cityTimePath, "utf8")) as GraphIR;
}

/**
 * Build a city-time variant with a second structured schema `Foo` produced
 * by a fresh function node. Lets us exercise the single-schema rail.
 */
function withSecondSchema(ir: GraphIR): GraphIR {
  const next: GraphIR = {
    ...ir,
    schemas: [
      ...ir.schemas,
      { name: "Foo", fields: [{ name: "bar", type: "str" }] },
    ],
    nodes: [
      ...ir.nodes,
      {
        id: "n_foo_producer",
        type: "function",
        name: "foo_producer",
        ui: { x: 1040, y: 0 },
        config: {
          description: "Emits a Foo.",
          inputType: "str",
          outputType: "Foo",
          emits: "output",
          body: null,
        },
      } as FunctionNode,
    ],
  };
  return next;
}

test("single-schema rail blocks a second schema once any chip is locked", () => {
  const ir = withSecondSchema(cloneFixture(loadCityTime()));

  // city_report already has CityTime chips in the fixture — rail engaged.
  const candidates = candidateVariables(ir, "n_report");
  const schemas = new Set(candidates.map((c) => c.schema));
  assert.deepStrictEqual(
    [...schemas].sort(),
    ["CityTime"],
    "rail must filter out Foo while CityTime chips are present",
  );
  // Sanity: CityTime fields still offered.
  const fields = candidates
    .filter((c) => c.source === "lookup_time")
    .map((c) => c.field)
    .sort();
  assert.deepStrictEqual(fields, ["city", "time_info"]);
});

test("no chips ⇒ all structured candidates offered (rail disengaged)", () => {
  const ir = withSecondSchema(cloneFixture(loadCityTime()));
  // Strip n_report's chips so the rail unlocks.
  const stripped = {
    ...ir,
    nodes: ir.nodes.map((n) => {
      if (n.id !== "n_report" || n.type !== "agent") return n;
      return {
        ...n,
        config: {
          ...n.config,
          instruction: { segments: [{ type: "text", value: "" }] },
          inputSchemaRef: null,
        },
      } as AgentNode;
    }),
  };
  const candidates = candidateVariables(stripped, "n_report");
  const schemas = new Set(candidates.map((c) => c.schema));
  assert.deepStrictEqual(
    [...schemas].sort(),
    ["CityTime", "Foo"],
    "both structured producers must be offered when no chips exist",
  );
});

test("excludes 'str' / null producers and the consuming agent itself", () => {
  const ir = cloneFixture(loadCityTime());
  // Unlock the rail so we can see the full unfiltered set.
  const stripped = {
    ...ir,
    nodes: ir.nodes.map((n) => {
      if (n.id !== "n_report" || n.type !== "agent") return n;
      return {
        ...n,
        config: {
          ...n.config,
          instruction: { segments: [] },
          inputSchemaRef: null,
        },
      } as AgentNode;
    }),
  };
  const candidates = candidateVariables(stripped, "n_report");

  // city_generator outputs "str" — must not appear.
  assert.ok(
    !candidates.some((c) => c.source === "city_generator"),
    "str-output agent must not be a candidate",
  );
  // completed_message has outputType: "str" — must not appear.
  assert.ok(
    !candidates.some((c) => c.source === "completed_message"),
    "str-output function must not be a candidate",
  );
  // The consuming agent itself must not appear as a source.
  assert.ok(
    !candidates.some((c) => c.source === "city_report"),
    "the consuming agent itself must not be a candidate",
  );
  // lookup_time (CityTime) is the only valid one in this fixture.
  assert.deepStrictEqual(
    [...new Set(candidates.map((c) => c.source))].sort(),
    ["lookup_time"],
  );
});

test("upstreamProducers walks reverse edges and feeds the UI advisory", () => {
  const ir = cloneFixture(loadCityTime());
  const upstream = upstreamProducers(ir, "n_report");
  // city-time: START → n_city_gen → n_lookup → n_report → n_done
  // Upstream of n_report by name: {city_generator, lookup_time}.
  assert.deepStrictEqual(
    [...upstream].sort(),
    ["city_generator", "lookup_time"],
  );

  // With the lookup → report edge removed, lookup_time is no longer upstream.
  const broken = { ...ir, edges: ir.edges.filter((e) => e.to !== "n_report") };
  const upstreamBroken = upstreamProducers(broken, "n_report");
  assert.strictEqual(upstreamBroken.size, 0);

  // candidateVariables reflects the change via the isUpstream flag.
  const stripped = {
    ...broken,
    nodes: broken.nodes.map((n) => {
      if (n.id !== "n_report" || n.type !== "agent") return n;
      return {
        ...n,
        config: {
          ...n.config,
          instruction: { segments: [] },
          inputSchemaRef: null,
        },
      } as AgentNode;
    }),
  };
  const candidates = candidateVariables(stripped, "n_report");
  assert.ok(candidates.length > 0);
  assert.ok(
    candidates.every((c) => c.isUpstream === false),
    "with the edge removed every candidate must be flagged not-upstream",
  );
});
