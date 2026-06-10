#!/usr/bin/env node
/**
 * End-to-end pipeline runner — exercises the full codegen path headless:
 * IR → validate → generateProject → black format → STORE zip → file on disk.
 *
 * Mirrors `scripts/check-ir.ts` (native TS, no install/build step). Not part
 * of `npm test` — this is a manual runner for the closing stages of the
 * pipeline (ADR-0020).
 *
 *   node scripts/compile.ts <fixture.ir.json> <out.zip> [--target=adk|langgraph]
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { GraphIR } from "../packages/ir/src/types.ts";
import {
  compile,
  ValidationError,
  type CodegenTarget,
} from "../packages/codegen/src/compile.ts";
import { formatProject } from "../packages/codegen/src/format.ts";
import { bundleZip } from "../packages/codegen/src/bundle.ts";
import { CodegenError } from "../packages/codegen/src/python.ts";

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="));
const positional = args.filter((a) => !a.startsWith("--"));
const [inPath, outPath] = positional;
const target = (targetArg?.slice("--target=".length) ?? "adk") as CodegenTarget;
if (!inPath || !outPath || (target !== "adk" && target !== "langgraph")) {
  console.error(
    "usage: node scripts/compile.ts <fixture.ir.json> <out.zip> [--target=adk|langgraph]",
  );
  process.exit(2);
}

let ir: GraphIR;
try {
  ir = JSON.parse(readFileSync(inPath, "utf8")) as GraphIR;
} catch (ex) {
  console.error(`cannot read ${inPath}: ${(ex as Error).message}`);
  process.exit(1);
}

try {
  const generated = compile(ir, { target });
  const { project, status } = formatProject(generated);
  const bytes = bundleZip(project, ir.name);
  writeFileSync(outPath, bytes);
  console.log(
    `OK  ${inPath} → ${outPath}  (${bytes.length} bytes, target=${target}, black=${status})`,
  );
} catch (ex) {
  if (ex instanceof ValidationError) {
    console.error(`validation failed: ${ex.message}`);
    process.exit(1);
  }
  if (ex instanceof CodegenError) {
    console.error(`codegen failed: ${ex.message}`);
    process.exit(1);
  }
  console.error((ex as Error).stack ?? (ex as Error).message);
  process.exit(1);
}
