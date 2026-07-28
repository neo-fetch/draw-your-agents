/**
 * Node-popover anchor spec (ADR-0057) — install-free tier: imports only
 * `src/inspector/popoverAnchor.ts`, which is dependency- and DOM-free by
 * design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANCHOR_GAP,
  ANCHOR_MARGIN,
  anchorPopover,
  fitHeight,
  midpointTarget,
} from "../src/inspector/popoverAnchor.ts";

const IDENTITY = { x: 0, y: 0, zoom: 1 };
const NO_OFFSET = { dx: 0, dy: 0 };
const ROOMY = { w: 2000, h: 1200 };
const CARD = { w: 380, h: 520 };

test("anchors to the right of the target, top-aligned, at zoom 1", () => {
  const got = anchorPopover({
    target: { x: 100, y: 60, w: 180, h: 60 },
    viewport: IDENTITY,
    container: ROOMY,
    size: CARD,
    offset: NO_OFFSET,
  });
  assert.equal(got.side, "right");
  assert.equal(got.left, 100 + 180 + ANCHOR_GAP);
  assert.equal(got.top, 60);
});

test("flips to the left when the right side would overrun the container", () => {
  const got = anchorPopover({
    target: { x: 500, y: 100, w: 180, h: 60 },
    viewport: IDENTITY,
    container: { w: 800, h: 1200 },
    size: CARD,
    offset: NO_OFFSET,
  });
  assert.equal(got.side, "left");
  assert.equal(got.left, 500 - ANCHOR_GAP - CARD.w);
});

test("scales the anchor by the viewport transform", () => {
  const got = anchorPopover({
    target: { x: 100, y: 200, w: 180, h: 60 },
    viewport: { x: 40, y: -30, zoom: 0.5 },
    container: ROOMY,
    size: CARD,
    offset: NO_OFFSET,
  });
  // left  = 40 + (100 + 180) * 0.5 + gap ; top = -30 + 200 * 0.5
  assert.equal(got.left, 40 + 140 + ANCHOR_GAP);
  assert.equal(got.top, 70);
});

test("clamps against every container edge", () => {
  const container = { w: 900, h: 700 };
  const base = {
    viewport: IDENTITY,
    container,
    size: CARD,
    offset: NO_OFFSET,
  };
  // above the top edge
  assert.equal(
    anchorPopover({ ...base, target: { x: 10, y: -400, w: 180, h: 60 } }).top,
    ANCHOR_MARGIN,
  );
  // below the bottom edge
  assert.equal(
    anchorPopover({ ...base, target: { x: 10, y: 5000, w: 180, h: 60 } }).top,
    container.h - CARD.h - ANCHOR_MARGIN,
  );
  // flipped left, but the target sits so far left there is no room either
  assert.equal(
    anchorPopover({ ...base, target: { x: -5000, y: 10, w: 180, h: 60 } }).left,
    ANCHOR_MARGIN,
  );
  // far right: flips, then clamps to the right edge
  assert.equal(
    anchorPopover({ ...base, target: { x: 5000, y: 10, w: 180, h: 60 } }).left,
    container.w - CARD.w - ANCHOR_MARGIN,
  );
});

test("a card larger than its container pins to the top-left margin", () => {
  const got = anchorPopover({
    target: { x: 0, y: 0, w: 180, h: 60 },
    viewport: IDENTITY,
    container: { w: 300, h: 200 },
    size: CARD,
    offset: NO_OFFSET,
  });
  assert.equal(got.left, ANCHOR_MARGIN);
  assert.equal(got.top, ANCHOR_MARGIN);
});

test("the drag offset moves the card, but is clamped like the anchor", () => {
  const target = { x: 100, y: 100, w: 180, h: 60 };
  const base = { target, viewport: IDENTITY, container: ROOMY, size: CARD };

  const moved = anchorPopover({ ...base, offset: { dx: 25, dy: -40 } });
  assert.equal(moved.left, 100 + 180 + ANCHOR_GAP + 25);
  assert.equal(moved.top, 60);

  // dragged far off-screen: still inside the container
  const yanked = anchorPopover({ ...base, offset: { dx: -9999, dy: 9999 } });
  assert.equal(yanked.left, ANCHOR_MARGIN);
  assert.equal(yanked.top, ROOMY.h - CARD.h - ANCHOR_MARGIN);
});

test("fitHeight caps the card at its container, margins included", () => {
  // room to spare: the persisted cap wins
  assert.equal(fitHeight(520, 900), 520);
  // taller than the container: the container wins, leaving both margins
  assert.equal(fitHeight(900, 600), 600 - ANCHOR_MARGIN * 2);
  // a container smaller than the margins never yields a negative height
  assert.equal(fitHeight(520, 4), 0);
});

test("midpointTarget is the zero-size midpoint of two node centers", () => {
  const got = midpointTarget(
    { x: 0, y: 0, w: 100, h: 40 },
    { x: 300, y: 200, w: 100, h: 60 },
  );
  // centers: (50, 20) and (350, 230)
  assert.deepEqual(got, { x: 200, y: 125, w: 0, h: 0 });
});
