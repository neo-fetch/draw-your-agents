/**
 * Target registry spec — install-free tier: imports only
 * `src/target/targets.ts`, which is dependency- and DOM-free by design
 * (its only import is the type-only `CodegenTarget`, erased at runtime).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceTarget,
  DEFAULT_TARGET,
  TARGET_BY_ID,
  TARGETS,
} from "../src/target/targets.ts";

test("registry: ids are exactly compile()'s contract — adk and langgraph", () => {
  const ids = TARGETS.map((t) => t.id).sort();
  assert.deepEqual(ids, ["adk", "langgraph"]);
});

test("registry: ids are unique and TARGET_BY_ID covers them all", () => {
  const ids = TARGETS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of TARGETS) assert.equal(TARGET_BY_ID.get(t.id), t);
});

test("registry: every target carries a label, a tag, and a blurb", () => {
  for (const t of TARGETS) {
    assert.ok(t.label.length > 0, `${t.id} label`);
    assert.match(t.tag, /^IR → /, `${t.id} tag`);
    assert.ok(t.blurb.length > 0, `${t.id} blurb`);
  }
});

test("default target is adk and registered", () => {
  assert.equal(DEFAULT_TARGET, "adk");
  assert.ok(TARGET_BY_ID.has(DEFAULT_TARGET));
});

test("coerceTarget: passes known ids through, defaults everything else", () => {
  for (const t of TARGETS) assert.equal(coerceTarget(t.id), t.id);
  assert.equal(coerceTarget("crewai"), DEFAULT_TARGET);
  assert.equal(coerceTarget(undefined), DEFAULT_TARGET);
  assert.equal(coerceTarget(null), DEFAULT_TARGET);
  assert.equal(coerceTarget(42), DEFAULT_TARGET);
});
