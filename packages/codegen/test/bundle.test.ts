/**
 * Round-trip tests for the STORE-only zip bundler (ADR-0020). The spec: for
 * every fixture, `bundleZip(generateProject(ir), ir.name)` archives to bytes
 * that `unzipStore` recovers as a map byte-equal to the generated project,
 * with every path prefixed by `ir.name/`. Also smoke-checks the EOCD shape so
 * a malformed writer fails loud rather than at unzip time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { generateProject } from "../src/project.ts";
import { generateLangGraphProject } from "../src/langgraph/project.ts";
import { bundleZip, unzipStore } from "../src/bundle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const PROJECTS = [
  { name: "city-time", fixture: "packages/ir/fixtures/city-time.ir.json" },
  { name: "routing", fixture: "packages/ir/fixtures/routing.ir.json" },
  { name: "parallel", fixture: "packages/ir/fixtures/parallel.ir.json" },
  { name: "human-input", fixture: "packages/ir/fixtures/human-input.ir.json" },
  { name: "nested", fixture: "packages/ir/fixtures/nested.ir.json" },
  { name: "tool", fixture: "packages/ir/fixtures/tool.ir.json" },
];

function loadIR(relPath: string): GraphIR {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as GraphIR;
}

for (const { name, fixture } of PROJECTS) {
  test(`${name}: bundleZip round-trips byte-equal under unzipStore`, () => {
    const ir = loadIR(fixture);
    const generated = generateProject(ir);
    const bytes = bundleZip(generated, ir.name);
    const recovered = unzipStore(bytes);

    const expected = new Map<string, string>();
    for (const [path, content] of generated) {
      expected.set(`${ir.name}/${path}`, content);
    }
    assert.equal(recovered.size, expected.size);
    for (const [path, content] of expected) {
      assert.equal(recovered.get(path), content, `${path}: contents differ after round-trip`);
    }
  });
}

test("langgraph project: bundleZip round-trips byte-equal under unzipStore", () => {
  // One LangGraph entry proves target-independence of the bundler (ADR-0045);
  // the byte-level zip mechanics are covered by the ADK loop above.
  const ir = loadIR("packages/ir/fixtures/city-time.ir.json");
  const generated = generateLangGraphProject(ir);
  const recovered = unzipStore(bundleZip(generated, ir.name));
  assert.equal(recovered.size, generated.size);
  for (const [path, content] of generated) {
    assert.equal(recovered.get(`${ir.name}/${path}`), content);
  }
});

test("EOCD shape matches the generated project's entry count", () => {
  const generated = generateProject(loadIR(PROJECTS[0]!.fixture));
  const bytes = bundleZip(generated, "x");
  // EOCD is the last 22 bytes when the archive has no comment.
  const eocd = bytes.subarray(bytes.length - 22);
  const dv = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  assert.equal(dv.getUint32(0, true), 0x06054b50, "EOCD signature");
  assert.equal(dv.getUint16(8, true), generated.size, "entries on this disk");
  assert.equal(dv.getUint16(10, true), generated.size, "total entries");
});
