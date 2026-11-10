/**
 * Headless tests for the save/load helpers (ADR-0024).
 *
 * The browser-only Blob/anchor/file-input shim lives in `Toolbar.tsx`; the
 * decision logic — parse-guard, "load-then-surface, don't gate" validation,
 * filename derivation — lives in `irIO.ts` and is exercised here under
 * `node --test` against the native TS loader (no `npm install`, no DOM).
 *
 * What this test pins:
 *   (1) save → load round-trips are byte-equal IR for the canonical fixture;
 *   (2) malformed JSON returns `{ok:false}` rather than throwing;
 *   (3) a valid JSON value that isn't a Graph IR object (number, string,
 *       null, array) is rejected by the shape guard;
 *   (4) a *partial* object (e.g. `{name:"x"}`) still loads — it surfaces
 *       `MISSING_TOP_LEVEL_KEY` findings rather than blocking the load,
 *       so the inspector can render and the user can fix it;
 *   (5) a semantically broken but well-shaped IR (the invalid fixture)
 *       also loads, carrying the expected validator findings;
 *   (6) filename helpers fall back to `graph.*` when `ir.name` is absent
 *       so we never write a file whose name starts with `.`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import {
  isFileDrag,
  loadIRFromFile,
  loadIRFromText,
  pickIRFile,
  serializeIR,
  suggestedSaveFilename,
  suggestedZipFilename,
} from "../src/store/irIO.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");
const cityTimePath = join(fixturesDir, "city-time.ir.json");
const brokenPath = join(fixturesDir, "invalid", "broken-var-and-graph.ir.json");

function loadJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

test("serializeIR + loadIRFromText round-trip the city-time fixture byte-for-byte", () => {
  const ir = loadJSON<GraphIR>(cityTimePath);
  const text = serializeIR(ir);
  const result = loadIRFromText(text);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.deepStrictEqual(result.ir, ir);
  assert.deepStrictEqual(
    result.findings,
    [],
    `city-time must round-trip clean, got: ${JSON.stringify(result.findings)}`,
  );
});

test("loadIRFromText rejects malformed JSON with ok:false (no throw)", () => {
  const result = loadIRFromText("{ not json");
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /JSON/i);
});

test("loadIRFromText rejects non-object payloads (number, string, null, array)", () => {
  for (const text of ["42", '"hello"', "null", "[1,2,3]"]) {
    const result = loadIRFromText(text);
    assert.strictEqual(result.ok, false, `payload ${text} must be rejected`);
    if (result.ok) continue;
    assert.match(result.error, /Graph IR/);
  }
});

test("loadIRFromText rejects objects missing the array fields the renderer iterates", () => {
  // The shape guard refuses to load anything the canvas/inspector/preview
  // would crash on. Found by manual smoke: `replaceIR({name:"x"})` blew up
  // React with `Cannot read properties of undefined (reading 'map')`, which
  // defeats "load-then-surface" because the user can't see what to fix.
  for (const payload of [
    { name: "x" },                       // missing nodes/edges/schemas
    { name: "x", nodes: [] },            // missing edges/schemas
    { nodes: [], edges: [] },            // missing schemas
    { nodes: "wrong", edges: [], schemas: [] }, // nodes not an array
  ]) {
    const result = loadIRFromText(JSON.stringify(payload));
    assert.strictEqual(
      result.ok,
      false,
      `payload ${JSON.stringify(payload)} must be rejected`,
    );
    if (result.ok) continue;
    assert.match(result.error, /must be an array/);
  }
});

test("loadIRFromText loads-then-surfaces a structurally-shaped object missing irVersion/name", () => {
  // All three array fields present → load it. validate() surfaces the
  // missing required keys as findings the banner can render.
  const result = loadIRFromText(JSON.stringify({ nodes: [], edges: [], schemas: [] }));
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  const codes = result.findings.map((f) => f.code);
  assert.ok(
    codes.includes("MISSING_TOP_LEVEL_KEY"),
    `expected MISSING_TOP_LEVEL_KEY, got: ${codes.join(", ")}`,
  );
});

test("loadIRFromText loads-then-surfaces the broken-var-and-graph invalid fixture", () => {
  const text = readFileSync(brokenPath, "utf8");
  const result = loadIRFromText(text);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.findings.length > 0, "invalid fixture must surface findings");
  const codes = new Set(result.findings.map((f) => f.code));
  // The fixture references a non-existent `CityTime.time_info` field and a
  // non-existent `Mystery` schema — at minimum we expect a var/schema-ref
  // class of finding to come back. Don't over-pin the exact code set so
  // validator improvements aren't blocked by this test.
  assert.ok(
    [...codes].some((c) => /VAR|SCHEMA|REF|OUTPUT/.test(c)),
    `expected a var/schema/ref-class finding, got: ${[...codes].join(", ")}`,
  );
});

test("suggestedSaveFilename and suggestedZipFilename use ir.name with a fallback", () => {
  assert.strictEqual(
    suggestedSaveFilename({ name: "city-time" } as GraphIR),
    "city-time.agentgraph.json",
  );
  assert.strictEqual(suggestedZipFilename({ name: "city-time" } as GraphIR), "city-time.zip");
  // Missing / empty name → never emit a file starting with `.`
  assert.strictEqual(suggestedSaveFilename({} as GraphIR), "graph.agentgraph.json");
  assert.strictEqual(suggestedZipFilename({ name: "" } as GraphIR), "graph.zip");
});

// --- drag-and-drop load (ADR-0060) ---

test("loadIRFromFile loads a Blob through the same path as loadIRFromText", async () => {
  const ir = loadJSON<GraphIR>(cityTimePath);
  const result = await loadIRFromFile(new Blob([serializeIR(ir)], { type: "application/json" }));
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.deepStrictEqual(result.ir, ir);
  assert.deepStrictEqual(result.findings, []);
});

test("loadIRFromFile returns ok:false for malformed JSON and for an unreadable file", async () => {
  const bad = await loadIRFromFile(new Blob(["{ not json"]));
  assert.strictEqual(bad.ok, false);
  const unreadable = await loadIRFromFile({
    text: () => Promise.reject(new Error("permission denied")),
  } as unknown as Blob);
  assert.strictEqual(unreadable.ok, false);
  if (unreadable.ok) return;
  assert.match(unreadable.error, /Could not read file: permission denied/);
});

test("isFileDrag is true only for OS file drags", () => {
  assert.strictEqual(isFileDrag(["Files"]), true);
  assert.strictEqual(isFileDrag(["application/x-moz-file", "Files"]), true);
  // palette node drag, text selection drag, empty
  assert.strictEqual(isFileDrag(["application/ga-node-type"]), false);
  assert.strictEqual(isFileDrag(["text/plain"]), false);
  assert.strictEqual(isFileDrag([]), false);
});

test("pickIRFile picks the first .json / application/json file", () => {
  const files = [
    { name: "notes.txt", type: "text/plain" },
    { name: "brd_pipeline.agentgraph.json", type: "" },
    { name: "other.json", type: "application/json" },
  ];
  const r = pickIRFile(files);
  assert.strictEqual(r.ok, true);
  if (r.ok) assert.strictEqual(r.file.name, "brd_pipeline.agentgraph.json");
  // extension check is case-insensitive; MIME alone also qualifies
  assert.strictEqual(pickIRFile([{ name: "GRAPH.JSON", type: "" }]).ok, true);
  assert.strictEqual(pickIRFile([{ name: "export", type: "application/json" }]).ok, true);
});

test("pickIRFile rejects drops with no JSON file, naming what was dropped", () => {
  const none = pickIRFile([]);
  assert.strictEqual(none.ok, false);
  const r = pickIRFile([
    { name: "project.zip", type: "application/zip" },
    { name: "diagram.png", type: "image/png" },
  ]);
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /project\.zip, diagram\.png/);
  assert.match(r.error, /\.agentgraph\.json/);
});
