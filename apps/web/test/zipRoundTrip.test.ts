/**
 * End-to-end round-trip for the web Download-zip path (ADR-0024).
 *
 * The Toolbar runs `compile(ir)` → `bundleZip(project, ir.name)` in the
 * browser and hands the bytes to the user. This test pins that exact
 * sequence — same modules, same call signatures — and asserts the bytes
 * round-trip byte-equal via `unzipStore`, with every path prefixed by
 * `ir.name/` (ADR-0020).
 *
 * It mirrors `packages/codegen/test/bundle.test.ts` (which calls
 * `generateProject` directly) but goes through `compile` so a regression
 * in the validate→generate→bundle chain that we ship to users fails *this*
 * suite, not just codegen's internal one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { compile, ValidationError } from "../../../packages/codegen/src/compile.ts";
import { bundleZip, unzipStore } from "../../../packages/codegen/src/bundle.ts";

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
  test(`${name}: compile→bundleZip round-trips byte-equal under unzipStore`, () => {
    const ir = loadIR(fixture);
    const project = compile(ir);
    const bytes = bundleZip(project, ir.name);
    const recovered = unzipStore(bytes);

    const expected = new Map<string, string>();
    for (const [path, content] of project) {
      expected.set(`${ir.name}/${path}`, content);
    }
    assert.equal(recovered.size, expected.size);
    for (const [path, content] of expected) {
      assert.equal(recovered.get(path), content, `${path}: contents differ after round-trip`);
    }
  });
}

test("compile throws ValidationError on an invalid IR so the Toolbar can gate the download", () => {
  const broken = loadIR("packages/ir/fixtures/invalid/broken-var-and-graph.ir.json");
  assert.throws(() => compile(broken), ValidationError);
});
