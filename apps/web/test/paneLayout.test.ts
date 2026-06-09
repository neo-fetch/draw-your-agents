/**
 * Pane layout model spec (ADR-0044) — install-free tier: imports only
 * `src/layout/paneLayout.ts`, which is dependency- and DOM-free by design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampWidth,
  defaultLayout,
  DEFAULT_WIDTHS,
  PANE_LIMITS,
  parseLayout,
  serializeLayout,
  SIDE_PANES,
} from "../src/layout/paneLayout.ts";

test("defaults sit inside the clamp limits", () => {
  for (const pane of SIDE_PANES) {
    const { min, max } = PANE_LIMITS[pane];
    assert.ok(DEFAULT_WIDTHS[pane] >= min && DEFAULT_WIDTHS[pane] <= max, pane);
  }
});

test("clampWidth: clamps, rounds, and recovers from non-finite input", () => {
  assert.equal(clampWidth("left", 100), PANE_LIMITS.left.min);
  assert.equal(clampWidth("left", 9999), PANE_LIMITS.left.max);
  assert.equal(clampWidth("left", 250.6), 251);
  assert.equal(clampWidth("preview", NaN), DEFAULT_WIDTHS.preview);
  assert.equal(clampWidth("preview", Infinity), DEFAULT_WIDTHS.preview);
});

test("parseLayout: round-trips serializeLayout output", () => {
  const layout = defaultLayout();
  layout.widths.inspector = 400;
  layout.collapsed.preview = true;
  assert.deepEqual(parseLayout(serializeLayout(layout)), layout);
});

test("parseLayout: tolerates garbage and partial shapes", () => {
  assert.deepEqual(parseLayout(null), defaultLayout());
  assert.deepEqual(parseLayout("not json"), defaultLayout());
  assert.deepEqual(parseLayout('"a string"'), defaultLayout());
  // partial: one valid width, the rest defaulted; out-of-range clamped
  const got = parseLayout('{"widths":{"left":9999},"collapsed":{"preview":true}}');
  assert.equal(got.widths.left, PANE_LIMITS.left.max);
  assert.equal(got.widths.inspector, DEFAULT_WIDTHS.inspector);
  assert.equal(got.collapsed.preview, true);
  assert.equal(got.collapsed.left, false);
});
