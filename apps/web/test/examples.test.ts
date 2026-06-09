/**
 * Headless tests for the example gallery (ADR-0042).
 *
 * The toolbar `<select>` is a browser-only shim; the decision logic — the
 * `EXAMPLES` list and `loadExample` (which funnels through `loadIRFromText`,
 * the Load IR path) — lives in `src/store/examples.ts` and is exercised here
 * under `node --test`.
 *
 * What this test pins:
 *   (1) every gallery entry loads `ok: true` with zero error-severity
 *       findings — the gallery mirrors `npm run check:ir`;
 *   (2) coverage guard — the gallery ids equal the `*.ir.json` set under
 *       `packages/ir/fixtures/` (a new fixture not added here fails loud);
 *   (3) isolation — two loads of the same example return distinct objects,
 *       and mutating one never leaks into the next load;
 *   (4) ids and labels are unique and non-empty;
 *   (5) an unknown id returns `{ok:false}` rather than throwing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EXAMPLES, loadExample } from "../src/store/examples.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

test("every example loads ok with zero error-severity findings", () => {
  for (const ex of EXAMPLES) {
    const result = loadExample(ex.id);
    assert.ok(result.ok, `${ex.id} failed to load`);
    const errors = result.findings.filter((f) => f.severity === "error");
    assert.deepEqual(errors, [], `${ex.id} loaded with errors`);
  }
});

test("coverage guard: gallery ids equal the valid fixture set on disk", () => {
  const onDisk = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".ir.json"))
    .map((f) => f.replace(/\.ir\.json$/, ""))
    .sort();
  const inGallery = EXAMPLES.map((e) => e.id).sort();
  assert.deepEqual(inGallery, onDisk);
});

test("repeat loads are isolated: distinct identities, no mutation leaks", () => {
  const first = loadExample("city-time");
  const second = loadExample("city-time");
  assert.ok(first.ok && second.ok);
  assert.notStrictEqual(first.ir, second.ir);
  first.ir.nodes.length = 0;
  const third = loadExample("city-time");
  assert.ok(third.ok);
  assert.ok(third.ir.nodes.length > 0, "mutation leaked into a later load");
});

test("ids and labels are unique and non-empty", () => {
  const ids = EXAMPLES.map((e) => e.id);
  const labels = EXAMPLES.map((e) => e.label);
  assert.equal(new Set(ids).size, EXAMPLES.length);
  assert.equal(new Set(labels).size, EXAMPLES.length);
  for (const ex of EXAMPLES) {
    assert.ok(ex.id.length > 0);
    assert.ok(ex.label.length > 0);
  }
});

test("unknown id returns ok:false rather than throwing", () => {
  const result = loadExample("no-such-example");
  assert.ok(!result.ok);
});
