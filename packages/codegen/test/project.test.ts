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

const BASE_FILES = [
  "schemas.py",
  "functions.py",
  "agents.py",
  "workflow.py",
  "agent.py",
  "main.py",
  "test_workflow.py",
  "requirements.txt",
  ".env.example",
  "README.md",
];

// Each golden project: the fixture IR, the golden directory under golden/, and
// any extra emitted files beyond `BASE_FILES` (ADR-0039: `loops.py` for graphs
// with any loop node).
const PROJECTS = [
  { name: "city-time", fixture: "packages/ir/fixtures/city-time.ir.json", extras: [] },
  { name: "routing", fixture: "packages/ir/fixtures/routing.ir.json", extras: [] },
  { name: "routing-continue", fixture: "packages/ir/fixtures/routing-continue.ir.json", extras: [] },
  { name: "parallel", fixture: "packages/ir/fixtures/parallel.ir.json", extras: [] },
  { name: "parallel-mid", fixture: "packages/ir/fixtures/parallel-mid.ir.json", extras: [] },
  { name: "human-input", fixture: "packages/ir/fixtures/human-input.ir.json", extras: [] },
  { name: "nested", fixture: "packages/ir/fixtures/nested.ir.json", extras: [] },
  { name: "tool", fixture: "packages/ir/fixtures/tool.ir.json", extras: [] },
  { name: "nested-schema", fixture: "packages/ir/fixtures/nested-schema.ir.json", extras: [] },
  { name: "critic-loop", fixture: "packages/ir/fixtures/critic-loop.ir.json", extras: ["loops.py"] },
  { name: "state-vars", fixture: "packages/ir/fixtures/state-vars.ir.json", extras: [] },
];

for (const { name, fixture, extras } of PROJECTS) {
  const expectedFiles = [...BASE_FILES, ...extras];
  test(`${name}: generates exactly the ARCHITECTURE §5 file set`, () => {
    const files = generateProject(loadIR(fixture));
    assert.deepEqual([...files.keys()].sort(), [...expectedFiles].sort());
  });

  for (const file of expectedFiles) {
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

test("rejects an unknown node type via the assembler's own guard", () => {
  // After ADR-0019 the assembler handles every v1 declarative type, so its
  // type guard now only fires on malformed IR with an unknown `type` string
  // (the validator should have caught it upstream with UNKNOWN_NODE_TYPE).
  const ir = {
    irVersion: "0.1.0",
    name: "has_bogus",
    schemas: [],
    nodes: [{ id: "b", type: "bogus", name: "mystery", config: {} }],
    edges: [{ from: "START", to: "b" }],
  } as unknown as GraphIR;
  assert.throws(() => generateProject(ir), CodegenError);
});
