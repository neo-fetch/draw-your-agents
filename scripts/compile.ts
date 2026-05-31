#!/usr/bin/env node
/**
 * End-to-end pipeline runner — exercises the full codegen path headless:
 * IR → validate → generateProject → black format → STORE zip → file on disk.
 *
 * Mirrors `scripts/check-ir.ts` (native TS, no install/build step). Not part
 * of `npm test` — this is a manual runner for the closing stages of the
 * pipeline (ADR-0020).
 *
 *   node scripts/compile.ts <fixture.ir.json> <out.zip>
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { GraphIR } from "../packages/ir/src/types.ts";
import { compile, ValidationError } from "../packages/codegen/src/compile.ts";
import { formatProject } from "../packages/codegen/src/format.ts";
import { bundleZip } from "../packages/codegen/src/bundle.ts";
import { CodegenError } from "../packages/codegen/src/python.ts";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/compile.ts <fixture.ir.json> <out.zip>");
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
  const generated = compile(ir);
  const { project, status } = formatProject(generated);
  const bytes = bundleZip(project, ir.name);
  writeFileSync(outPath, bytes);
  console.log(`OK  ${inPath} → ${outPath}  (${bytes.length} bytes, black=${status})`);
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
