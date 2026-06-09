#!/usr/bin/env node
/**
 * Golden regeneration tool — re-emits every golden project under
 * `packages/codegen/test/golden/<name>/` from its fixture via `generateProject`
 * (ADR-0041). Mirrors `scripts/compile.ts` (native TS, no install/build step).
 * Not part of `npm test` — this is a manual tool for when the codegen spec
 * deliberately changes.
 *
 * DISCIPLINE: the golden diff IS the spec change. Review it line-by-line with
 * `git diff` before committing; never run this to silence a red golden test
 * you don't understand.
 *
 *   node scripts/update-goldens.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR } from "../packages/ir/src/types.ts";
import { generateProject } from "../packages/codegen/src/project.ts";

// Keep in sync with PROJECTS in packages/codegen/test/project.test.ts.
const PROJECTS = [
  { name: "city-time", fixture: "packages/ir/fixtures/city-time.ir.json" },
  { name: "routing", fixture: "packages/ir/fixtures/routing.ir.json" },
  { name: "parallel", fixture: "packages/ir/fixtures/parallel.ir.json" },
  { name: "human-input", fixture: "packages/ir/fixtures/human-input.ir.json" },
  { name: "nested", fixture: "packages/ir/fixtures/nested.ir.json" },
  { name: "tool", fixture: "packages/ir/fixtures/tool.ir.json" },
  { name: "nested-schema", fixture: "packages/ir/fixtures/nested-schema.ir.json" },
  { name: "critic-loop", fixture: "packages/ir/fixtures/critic-loop.ir.json" },
];

const goldenRoot = join("packages", "codegen", "test", "golden");

for (const { name, fixture } of PROJECTS) {
  const ir = JSON.parse(readFileSync(fixture, "utf8")) as GraphIR;
  const files = generateProject(ir);
  const dir = join(goldenRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of files) {
    writeFileSync(join(dir, file), content);
  }
  console.log(`OK  ${name}  (${files.size} files)`);
}
