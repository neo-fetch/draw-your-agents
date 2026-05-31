/**
 * Golden-file tests for the project assembler (ARCHITECTURE.md §5, ADR-0003).
 * The golden fixtures under golden/city-time/ are the codegen spec: an IR in, a
 * runnable ADK project file set out. A second "trust" check shells out to
 * `python3 -m py_compile` on every generated `.py` to prove syntactic validity
 * (py_compile only — it does not import ADK, per the slice scope).
 *
 * Runs on Node's native TypeScript support — no build step (ADR-0011).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { generateProject } from "../src/project.ts";
import { CodegenError } from "../src/python.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function loadIR(relPath: string): GraphIR {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as GraphIR;
}

function loadGolden(project: string, file: string): string {
  return readFileSync(join(here, "golden", project, file), "utf8");
}

const EXPECTED_FILES = [
  "schemas.py",
  "functions.py",
  "agents.py",
  "workflow.py",
  "requirements.txt",
  ".env.example",
  "README.md",
];

// Each golden project: the fixture IR and the golden directory under golden/.
const PROJECTS = [
  { name: "city-time", fixture: "packages/ir/fixtures/city-time.ir.json" },
  { name: "routing", fixture: "packages/ir/fixtures/routing.ir.json" },
  { name: "parallel", fixture: "packages/ir/fixtures/parallel.ir.json" },
  { name: "human-input", fixture: "packages/ir/fixtures/human-input.ir.json" },
];

for (const { name, fixture } of PROJECTS) {
  test(`${name}: generates exactly the ARCHITECTURE §5 file set`, () => {
    const files = generateProject(loadIR(fixture));
    assert.deepEqual([...files.keys()].sort(), [...EXPECTED_FILES].sort());
  });

  for (const file of EXPECTED_FILES) {
    test(`${name}: ${file} matches golden`, () => {
      const files = generateProject(loadIR(fixture));
      assert.equal(files.get(file), loadGolden(name, file));
    });
  }

  test(`${name}: trust check — every generated .py passes python3 -m py_compile`, () => {
    const files = generateProject(loadIR(fixture));
    const dir = mkdtempSync(join(tmpdir(), "ga-codegen-"));
    const pyFiles: string[] = [];
    for (const [file, content] of files) {
      const path = join(dir, file);
      writeFileSync(path, content);
      if (file.endsWith(".py")) pyFiles.push(path);
    }
    assert.ok(pyFiles.length > 0, "expected at least one .py file");
    // py_compile only — proves syntax, does not import ADK.
    execFileSync("python3", ["-m", "py_compile", ...pyFiles], { stdio: "pipe" });
  });
}

test("rejects an out-of-slice node type via the assembler's own guard", () => {
  // A `tool` node passes the edges compiler (it linearizes fine) but is not an
  // agent/function/router/join, so generateProject rejects it with CodegenError.
  const ir = {
    irVersion: "0.1.0",
    name: "has_tool",
    schemas: [],
    nodes: [{ id: "t", type: "tool", name: "fetch", config: {} }],
    edges: [{ from: "START", to: "t" }],
  } as unknown as GraphIR;
  assert.throws(() => generateProject(ir), CodegenError);
});

test("rejects an out-of-slice node type (workflow) loud", () => {
  // A nested `workflow` node is Phase 3 and rejected loud by the assembler.
  const ir = {
    irVersion: "0.1.0",
    name: "has_nested",
    schemas: [],
    nodes: [{ id: "w", type: "workflow", name: "nested", config: {} }],
    edges: [{ from: "START", to: "w" }],
  } as unknown as GraphIR;
  assert.throws(() => generateProject(ir), CodegenError);
});
