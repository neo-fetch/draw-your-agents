#!/usr/bin/env node
/**
 * IR conformance gate — runs the authoritative TypeScript validator
 * (packages/ir) over fixture files and exits non-zero if any has errors.
 * Supersedes the Phase-0 Python stand-in scripts/check_ir.py (ADR-0013).
 *
 * Runs on Node's native TypeScript support — no build/install step.
 *
 *   node scripts/check-ir.ts packages/ir/fixtures/*.ir.json
 */
import { readFileSync } from "node:fs";
import type { GraphIR } from "../packages/ir/src/types.ts";
import { validate } from "../packages/ir/src/validate.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node scripts/check-ir.ts <fixture.ir.json> ...");
  process.exit(2);
}

let ok = true;
for (const p of paths) {
  let ir: GraphIR;
  try {
    ir = JSON.parse(readFileSync(p, "utf8")) as GraphIR;
  } catch (ex) {
    ok = false;
    console.log(`FAIL ${p}: cannot parse JSON: ${(ex as Error).message}`);
    continue;
  }

  const { errors, warnings } = validate(ir);
  if (errors.length > 0) {
    ok = false;
    console.log(`FAIL ${p}  (${errors.length} error(s)):`);
    for (const f of errors) console.log(`  - [${f.code}] ${f.message}`);
  } else {
    const counts =
      `${ir.nodes?.length ?? 0} nodes, ` +
      `${ir.edges?.length ?? 0} edges, ` +
      `${ir.schemas?.length ?? 0} schemas`;
    const warn = warnings.length > 0 ? `, ${warnings.length} warning(s)` : "";
    console.log(`PASS ${p}  (${counts}${warn})`);
  }
}

process.exit(ok ? 0 : 1);
