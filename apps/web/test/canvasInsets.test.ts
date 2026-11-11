/**
 * Visible-canvas insets (ADR-0062): the canvas sits full-bleed behind the
 * glass top bar and panes; these helpers keep fit/focus inside the hole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeInsets,
  fitPadding,
  FIT_GAP,
  sameInsets,
  visibleCenterTarget,
  ZERO_INSETS,
} from "../src/layout/canvasInsets.ts";

const canvas = { left: 0, top: 0, right: 1440, bottom: 900 };

test("computeInsets measures the hole the panes leave, in whole px, never negative", () => {
  const visible = { left: 246.4, top: 99.6, right: 950, bottom: 900 };
  assert.deepStrictEqual(computeInsets(canvas, visible), { top: 100, right: 490, bottom: 0, left: 246 });
  // a window larger than the canvas (mid-transition) clamps to 0
  assert.deepStrictEqual(
    computeInsets(canvas, { left: -5, top: -5, right: 1450, bottom: 905 }),
    ZERO_INSETS,
  );
});

test("fitPadding frames the visible window plus a gap, per side in px", () => {
  assert.deepStrictEqual(fitPadding({ top: 100, right: 490, bottom: 0, left: 246 }), {
    top: `${100 + FIT_GAP}px`,
    right: `${490 + FIT_GAP}px`,
    bottom: `${FIT_GAP}px`,
    left: `${246 + FIT_GAP}px`,
  });
});

test("visibleCenterTarget shifts setCenter so the point lands mid-window", () => {
  const insets = { top: 100, right: 400, bottom: 0, left: 200 };
  // visible centre is 100px left of and 50px below the container centre (screen);
  // at zoom 2 that is 50 / 25 flow units
  assert.deepStrictEqual(visibleCenterTarget({ x: 500, y: 300 }, insets, 2), { x: 550, y: 275 });
  assert.deepStrictEqual(visibleCenterTarget({ x: 10, y: 10 }, ZERO_INSETS, 1), { x: 10, y: 10 });
});

test("sameInsets compares all four sides", () => {
  assert.ok(sameInsets(ZERO_INSETS, { top: 0, right: 0, bottom: 0, left: 0 }));
  assert.ok(!sameInsets(ZERO_INSETS, { top: 0, right: 0, bottom: 1, left: 0 }));
});
