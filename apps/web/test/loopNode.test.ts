/**
 * Headless oracle for the loop-node UI integration (ADR-0040).
 *
 * Pins the contract the inspector exists to uphold: (a) the
 * minted-by-construction `LoopConfig` is codegen-valid — wiring
 * `START → loop` produces a clean validate and a `loops.py` with the
 * `@node` orchestrator + the canonical wrapper schemas, plus a
 * `("START", <name>_orchestrator)` row in `workflow.py`; (b) nested
 * sub-agent edits via the shallow-merge `applyNodeConfigPatch`
 * (mirror of `updateNodeConfig`) flow through to the emitted
 * orchestrator; (c) `LoopConfig` round-trips through plain JSON
 * (Save IR / Load IR posture, ADR-0024).
 *
 * Runs under `node --test` against the native TS loader — no
 * `npm install`, no zustand, no React (ADR-0011 / ADR-0013 / ADR-0022).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphIR, LoopNode } from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/compile.ts";
import { addNode } from "../src/store/addNode.ts";
import { applyNodeConfigPatch } from "../src/store/irReducer.ts";

function emptyIR(): GraphIR {
  return {
    irVersion: "0.1.0",
    name: "loop_smoke",
    schemas: [],
    nodes: [],
    edges: [],
  };
}

// --- (a) Default loop compiles after wiring START → loop -----------------

test("addNode('loop') default config validates clean once wired and compiles to a loops.py orchestrator", () => {
  const { ir: withLoop, nodeId } = addNode(emptyIR(), "loop");
  const wired: GraphIR = {
    ...withLoop,
    edges: [{ from: "START", to: nodeId }],
  };

  const result = validate(wired);
  assert.strictEqual(
    result.ok,
    true,
    `expected clean validate, got: ${JSON.stringify(result.errors)}`,
  );

  const project = compile(wired);
  const loops = project.get("loops.py") ?? "";
  assert.ok(loops.length > 0, "loops.py must be emitted for a loop node");

  // The orchestrator symbol mirrors the `<name>_orchestrator` convention
  // ADR-0039 pins (codegen's `rowSymbol` + `loopOrchestratorSymbol`).
  const loopNode = wired.nodes.find((n) => n.id === nodeId) as LoopNode;
  const orchestrator = `${loopNode.name}_orchestrator`;
  assert.ok(
    loops.includes(`async def ${orchestrator}`),
    `loops.py must define ${orchestrator}`,
  );
  // Canonical wrapper schemas (one per loop, namespaced by node name).
  assert.ok(loops.includes(`${loopNode.name}_GenInput`));
  assert.ok(loops.includes(`${loopNode.name}_CriticInput`));
  assert.ok(loops.includes(`${loopNode.name}_CriticOutput`));
  assert.ok(loops.includes(`${loopNode.name}_ReviserInput`));
  // Validator floor — default `maxIterations: 5` reached the for-loop bound.
  assert.ok(loops.includes("range(5)"));
  // Default approval phrase
  assert.ok(loops.includes("APPROVED"));

  // The outer graph's edge row uses the orchestrator symbol, not the
  // raw node name (proves ADR-0039 `rowSymbol` wiring).
  const workflow = project.get("workflow.py") ?? "";
  assert.ok(
    workflow.includes(`("START", ${orchestrator})`)
      || workflow.includes(`("START", ${orchestrator},`),
    `workflow.py must reference ${orchestrator} in a START edge — got:\n${workflow}`,
  );
});

// --- (b) Sub-agent + maxIterations edits flow into the orchestrator ------

test("nested sub-agent edits via applyNodeConfigPatch reach the emitted orchestrator", () => {
  const { ir: withLoop, nodeId } = addNode(emptyIR(), "loop");
  const wired: GraphIR = {
    ...withLoop,
    edges: [{ from: "START", to: nodeId }],
  };

  // Same shallow-merge dispatch the LoopForm uses — re-supply the
  // whole `generator` sub-object when swapping a single field.
  const loop = wired.nodes.find((n) => n.id === nodeId) as LoopNode;
  const cfg = loop.config;
  let edited = applyNodeConfigPatch(wired, nodeId, { maxIterations: 9 });
  edited = applyNodeConfigPatch(edited, nodeId, {
    generator: { ...cfg.generator, model: "gemini-flash-latest-pro" },
  });

  const result = validate(edited);
  assert.strictEqual(
    result.ok,
    true,
    `expected clean validate after edits, got: ${JSON.stringify(result.errors)}`,
  );

  const loops = compile(edited).get("loops.py") ?? "";
  assert.ok(loops.includes("range(9)"), "maxIterations: 9 must reach loops.py");
  assert.ok(
    loops.includes("gemini-flash-latest-pro"),
    "generator.model edit must reach loops.py",
  );
});

// --- (c) LoopConfig round-trips through plain JSON -----------------------

test("LoopConfig round-trips through JSON.stringify/parse (Save IR / Load IR posture)", () => {
  const { ir: withLoop, nodeId } = addNode(emptyIR(), "loop");
  const loop = withLoop.nodes.find((n) => n.id === nodeId) as LoopNode;
  const cfg = loop.config;

  let edited = applyNodeConfigPatch(withLoop, nodeId, {
    approvalPhrase: "SHIP_IT",
  });
  edited = applyNodeConfigPatch(edited, nodeId, {
    generator: { ...cfg.generator, model: "gemini-flash-latest-pro" },
  });
  const editedLoop = edited.nodes.find((n) => n.id === nodeId) as LoopNode;
  edited = applyNodeConfigPatch(edited, nodeId, {
    reviser: { ...editedLoop.config.reviser, instruction: "Be terse." },
  });

  const roundTripped = JSON.parse(JSON.stringify(edited)) as GraphIR;
  assert.deepStrictEqual(
    roundTripped,
    edited,
    "LoopConfig + sub-agents must survive JSON round-trip byte-for-byte",
  );
});
