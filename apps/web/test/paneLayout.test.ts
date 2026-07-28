/**
 * Pane layout model spec (ADR-0044) — install-free tier: imports only
 * `src/layout/paneLayout.ts`, which is dependency- and DOM-free by design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPopoverSize,
  clampWidth,
  defaultLayout,
  DEFAULT_POPOVER,
  DEFAULT_WIDTHS,
  PANE_LIMITS,
  POPOVER_LIMITS,
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

test("side panes are the two that survived ADR-0057", () => {
  assert.deepEqual([...SIDE_PANES], ["left", "preview"]);
});

test("parseLayout: round-trips serializeLayout output", () => {
  const layout = defaultLayout();
  layout.widths.preview = 400;
  layout.collapsed.preview = true;
  layout.popover = { w: 420, h: 600 };
  assert.deepEqual(parseLayout(serializeLayout(layout)), layout);
});

test("parseLayout: tolerates garbage and partial shapes", () => {
  assert.deepEqual(parseLayout(null), defaultLayout());
  assert.deepEqual(parseLayout("not json"), defaultLayout());
  assert.deepEqual(parseLayout('"a string"'), defaultLayout());
  // partial: one valid width, the rest defaulted; out-of-range clamped
  const got = parseLayout('{"widths":{"left":9999},"collapsed":{"preview":true}}');
  assert.equal(got.widths.left, PANE_LIMITS.left.max);
  assert.equal(got.widths.preview, DEFAULT_WIDTHS.preview);
  assert.equal(got.collapsed.preview, true);
  assert.equal(got.collapsed.left, false);
  assert.deepEqual(got.popover, DEFAULT_POPOVER);
});

test("parseLayout: a layout stored before ADR-0057 drops its inspector pane", () => {
  const got = parseLayout(
    '{"widths":{"left":200,"inspector":348,"preview":500},' +
      '"collapsed":{"left":false,"inspector":true,"preview":false}}',
  );
  assert.deepEqual(Object.keys(got.widths).sort(), ["left", "preview"]);
  assert.deepEqual(Object.keys(got.collapsed).sort(), ["left", "preview"]);
  assert.equal(got.widths.left, 200);
  assert.equal(got.widths.preview, 500);
  // and re-serializing sheds the stale key for good
  assert.ok(!serializeLayout(got).includes("inspector"));
});

test("clampPopoverSize: clamps, rounds, and recovers from non-finite input", () => {
  assert.deepEqual(clampPopoverSize({ w: 10, h: 10 }), {
    w: POPOVER_LIMITS.w.min,
    h: POPOVER_LIMITS.h.min,
  });
  assert.deepEqual(clampPopoverSize({ w: 9999, h: 9999 }), {
    w: POPOVER_LIMITS.w.max,
    h: POPOVER_LIMITS.h.max,
  });
  assert.deepEqual(clampPopoverSize({ w: 400.4, h: 500.6 }), { w: 400, h: 501 });
  assert.deepEqual(clampPopoverSize({ w: NaN, h: Infinity }), DEFAULT_POPOVER);
});

test("the default popover size sits inside its limits", () => {
  for (const axis of ["w", "h"] as const) {
    const { min, max } = POPOVER_LIMITS[axis];
    assert.ok(DEFAULT_POPOVER[axis] >= min && DEFAULT_POPOVER[axis] <= max, axis);
  }
});
