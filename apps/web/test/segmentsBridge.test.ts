/**
 * Headless round-trip oracle for the segments ↔ Lexical bridge (ADR-0029).
 *
 * The bridge is the spec: no codegen golden covers this UI-only round-trip,
 * so these tests are what catches regressions. Runs under `node --test`
 * against the native TS loader with **no `npm install`** — the bridge
 * itself imports no `lexical` symbols, so this file doesn't pull React or
 * Lexical into the cold-checkout test gate.
 *
 * Covers (per the slice prompt):
 *  (a) city-time report agent: segments → state → segments is identity
 *      modulo text-coalescing.
 *  (b) multi-line text segment round-trips its `\n`.
 *  (c) empty prompt round-trips to itself.
 *  (d) hand-written chip-at-start and chip-at-end shapes round-trip.
 *  (e) pinned chip-JSON-shape — a snapshot that fails loud if a Lexical
 *      upgrade silently changes the `VariableNode.exportJSON()` shape and
 *      breaks deserialization.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentNode, GraphIR, InstructionSegment } from "@graphical-agents/ir";
import {
  editorStateToSegments,
  segmentsToEditorState,
  varLabel,
  type SerializedEditorState,
} from "../src/inspector/segmentsBridge.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");
const cityTimePath = join(fixturesDir, "city-time.ir.json");

function loadCityTime(): GraphIR {
  return JSON.parse(readFileSync(cityTimePath, "utf8")) as GraphIR;
}

function roundTrip(segments: InstructionSegment[]): InstructionSegment[] {
  return editorStateToSegments(segmentsToEditorState(segments));
}

test("city-time report agent: segments → state → segments is identity", () => {
  const ir = loadCityTime();
  const report = ir.nodes.find((n) => n.id === "n_report") as AgentNode;
  const original = report.config.instruction.segments;
  // Sanity-check the fixture we're pinning against — chip-bracketed text
  // exercising var + text interleaving + an embedded \n.
  assert.strictEqual(original.length, 5);
  assert.strictEqual(original[0]?.type, "text");
  assert.strictEqual(original[1]?.type, "var");
  assert.strictEqual(original[3]?.type, "var");

  const round = roundTrip(original);
  assert.deepStrictEqual(round, original);
});

test("multi-line text segment round-trips its `\\n` characters", () => {
  const segs: InstructionSegment[] = [
    { type: "text", value: "line one\nline two\nline three" },
  ];
  assert.deepStrictEqual(roundTrip(segs), segs);
});

test("empty prompt (segments: []) → valid empty editor → []", () => {
  const state = segmentsToEditorState([]);
  // Editor mounts cleanly with one empty paragraph (not zero paragraphs).
  assert.strictEqual(state.root.children.length, 1);
  assert.strictEqual(state.root.children[0]?.type, "paragraph");
  assert.deepStrictEqual(state.root.children[0]?.children, []);
  assert.deepStrictEqual(editorStateToSegments(state), []);
});

test("chip at start and chip at end: [var, text, var] round-trips losslessly", () => {
  const segs: InstructionSegment[] = [
    { type: "var", schema: "CityTime", field: "city", source: "lookup_time" },
    { type: "text", value: " between " },
    {
      type: "var",
      schema: "CityTime",
      field: "time_info",
      source: "lookup_time",
    },
  ];
  assert.deepStrictEqual(roundTrip(segs), segs);
});

test("state var chip (via: state) round-trips with its via flag and {schema.field} label", () => {
  const segs: InstructionSegment[] = [
    { type: "text", value: "Anchor: " },
    {
      type: "var",
      schema: "Analysis",
      field: "key_point",
      source: "analyze",
      via: "state",
    },
  ];
  assert.deepStrictEqual(roundTrip(segs), segs);
  // The chip label uses the {schema.field} session form, matching codegen.
  assert.equal(varLabel("Analysis", "key_point", "analyze", "state"), "{Analysis.key_point}");
});

test("adjacent text segments coalesce on the way out", () => {
  // Two adjacent text segments are indistinguishable from one once they hit
  // the editor — coalescing is the documented behavior, not a bug.
  const segs: InstructionSegment[] = [
    { type: "text", value: "hello " },
    { type: "text", value: "world" },
  ];
  assert.deepStrictEqual(roundTrip(segs), [
    { type: "text", value: "hello world" },
  ]);
});

test("pinned chip-JSON-shape: VariableNode serialization is stable", () => {
  // This is the load-bearing pin. `VariableNode.exportJSON()` in
  // `VariableNode.ts` MUST emit this exact shape (modulo the `text` label),
  // or Lexical's `parseEditorState` will silently drop the chip. If a
  // future Lexical upgrade changes the required base shape, this test
  // fails loud and we update both ends in lockstep.
  const state = segmentsToEditorState([
    { type: "var", schema: "CityTime", field: "city", source: "lookup_time" },
  ]);
  const chip = state.root.children[0]?.children[0];
  assert.deepStrictEqual(chip, {
    type: "variable",
    text: varLabel("CityTime", "city", "lookup_time"),
    format: 0,
    detail: 0,
    mode: "token",
    style: "",
    version: 1,
    schema: "CityTime",
    field: "city",
    source: "lookup_time",
  });
  assert.strictEqual(
    varLabel("CityTime", "city", "lookup_time"),
    "<CityTime.city from lookup_time>",
    "chip label must match the codegen source-bound form (ADR-0008)",
  );
});

test("unknown editor-state node types are skipped, not crashed", () => {
  // Forward-compat: if Lexical inserts a node type we don't recognize
  // (e.g. a future format node), the bridge skips it without dropping the
  // surrounding text/vars.
  const state: SerializedEditorState = {
    root: {
      type: "root",
      format: "",
      indent: 0,
      version: 1,
      direction: null,
      children: [
        {
          type: "paragraph",
          format: "",
          indent: 0,
          version: 1,
          direction: null,
          textFormat: 0,
          textStyle: "",
          children: [
            {
              type: "text",
              text: "a",
              format: 0,
              detail: 0,
              mode: "normal",
              style: "",
              version: 1,
            },
            // pretend a future Lexical node showed up
            // deliberately wrong shape — bridge must skip it
            { type: "mystery-future-thing", version: 1 } as unknown as never,
            {
              type: "text",
              text: "b",
              format: 0,
              detail: 0,
              mode: "normal",
              style: "",
              version: 1,
            },
          ],
        },
      ],
    },
  };
  assert.deepStrictEqual(editorStateToSegments(state), [
    { type: "text", value: "ab" },
  ]);
});
