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

function loadGolden(file: string): string {
  return readFileSync(join(here, "golden", "city-time", file), "utf8");
}

const CITY_TIME = "packages/ir/fixtures/city-time.ir.json";
const EXPECTED_FILES = [
  "schemas.py",
  "functions.py",
  "agents.py",
  "workflow.py",
  "requirements.txt",
  ".env.example",
  "README.md",
];

test("city-time: generates exactly the ARCHITECTURE §5 file set", () => {
  const files = generateProject(loadIR(CITY_TIME));
  assert.deepEqual([...files.keys()].sort(), [...EXPECTED_FILES].sort());
});

for (const file of EXPECTED_FILES) {
  test(`city-time: ${file} matches golden`, () => {
    const files = generateProject(loadIR(CITY_TIME));
    assert.equal(files.get(file), loadGolden(file));
  });
}

test("city-time: trust check — every generated .py passes python3 -m py_compile", () => {
  const files = generateProject(loadIR(CITY_TIME));
  const dir = mkdtempSync(join(tmpdir(), "ga-codegen-"));
  const pyFiles: string[] = [];
  for (const [name, content] of files) {
    const path = join(dir, name);
    writeFileSync(path, content);
    if (name.endsWith(".py")) pyFiles.push(path);
  }
  assert.ok(pyFiles.length > 0, "expected at least one .py file");
  // py_compile only — proves syntax, does not import ADK.
  execFileSync("python3", ["-m", "py_compile", ...pyFiles], { stdio: "pipe" });
});

test("rejects an out-of-slice node type via the assembler's own guard", () => {
  // A `tool` node passes the edges compiler (it linearizes fine) but is not an
  // agent/function, so generateProject rejects it with CodegenError.
  const ir = {
    irVersion: "0.1.0",
    name: "has_tool",
    schemas: [],
    nodes: [{ id: "t", type: "tool", name: "fetch", config: {} }],
    edges: [{ from: "START", to: "t" }],
  } as unknown as GraphIR;
  assert.throws(() => generateProject(ir), CodegenError);
});

test("rejects an out-of-slice graph shape (humanInput) loud", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "has_human",
    schemas: [],
    nodes: [{ id: "h", type: "humanInput", name: "ask", config: { message: "?" } }],
    edges: [{ from: "START", to: "h" }],
  };
  assert.throws(() => generateProject(ir));
});

test("rejects a router graph (out-of-slice shape) loud", () => {
  const ir: GraphIR = {
    irVersion: "0.1.0",
    name: "has_router",
    schemas: [],
    nodes: [{ id: "r", type: "router", name: "r", config: { routes: ["X"] } }],
    edges: [{ from: "START", to: "r" }],
  };
  assert.throws(() => generateProject(ir));
});
