/**
 * Tests for the codegen entry pipeline (ADR-0013): compile = validate → throw on
 * errors → generateProject. Runs on Node's native TypeScript support — no build
 * step, and the validator is reached via a relative source import so this is
 * green from a cold checkout (ADR-0011).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { compile, ValidationError } from "../src/compile.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function loadIR(relPath: string): GraphIR {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as GraphIR;
}

test("compile(city-time) validates clean and returns the project file set", () => {
  const files = compile(loadIR("packages/ir/fixtures/city-time.ir.json"));
  assert.ok(files instanceof Map);
  assert.ok(files.has("workflow.py"));
  assert.ok(files.has("schemas.py"));
});

test("compile(invalid IR) throws ValidationError carrying the findings", () => {
  const ir = loadIR("packages/ir/fixtures/invalid/broken-var-and-graph.ir.json");
  assert.throws(
    () => compile(ir),
    (e: unknown) => {
      assert.ok(e instanceof ValidationError);
      assert.ok(e.findings.length > 0);
      assert.ok(e.findings.every((f) => f.severity === "error"));
      return true;
    },
  );
});
