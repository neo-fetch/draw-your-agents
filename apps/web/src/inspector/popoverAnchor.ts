/**
 * Node-popover anchor model (ADR-0057) — framework-free on purpose (no
 * zustand, no DOM, no React Flow) so `test/popoverAnchor.test.ts` runs under
 * bare `node --test`. Same posture as `layout/paneLayout.ts`: the pure model
 * here, the thin React wrapper in `NodePopover.tsx`.
 *
 * Everything is computed in *screen* pixels relative to the React Flow
 * container, which is the popover's positioning context.
 */

/** Gap between the node's edge and the popover, in screen px. */
export const ANCHOR_GAP = 12;

/** Minimum breathing room between the popover and the container edges. */
export const ANCHOR_MARGIN = 8;

export interface AnchorInput {
  /** Anchor rect in flow coordinates (a node's box, or a zero-size point). */
  target: { x: number; y: number; w: number; h: number };
  /** React Flow viewport transform. */
  viewport: { x: number; y: number; zoom: number };
  /** React Flow container size in px. */
  container: { w: number; h: number };
  /** Popover size in px. */
  size: { w: number; h: number };
  /** User drag offset in px, applied on top of the anchored position. */
  offset: { dx: number; dy: number };
  /**
   * Parts of the container covered by glass chrome (ADR-0062): the popover
   * flips and clamps within the visible window, never under a pane.
   */
  insets?: { top: number; right: number; bottom: number; left: number };
}

export interface AnchorResult {
  left: number;
  top: number;
  /** Which side of the target the popover landed on before clamping. */
  side: "right" | "left";
  /**
   * Set when the card is stacked below/above the target: the room there.
   * The card scrolls within it. Always set for a stacked card (not only when
   * it would overflow) so the measured height can't oscillate between
   * "fits uncapped" and "capped".
   */
  maxHeight?: number;
}

/** A stacked card shorter than this is useless — overlap the node instead. */
export const MIN_STACK_HEIGHT = 200;

function clamp(value: number, min: number, max: number): number {
  // A popover taller/wider than its container makes max < min; pinning to the
  // top-left edge is more useful than letting the clamp invert.
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Place the popover beside the target: to its right by default, flipped to
 * the left when the right side would overrun the container. When neither
 * side fits (a narrow visible window between glass panes, ADR-0062), it goes
 * below the target, else above — clamping a side placement would otherwise
 * park the card on top of the very node it edits. The drag offset is applied
 * *before* clamping, so a card dragged too far still snaps back inside the
 * viewport instead of disappearing.
 */
export function anchorPopover({
  target,
  viewport,
  container,
  size,
  offset,
  insets = { top: 0, right: 0, bottom: 0, left: 0 },
}: AnchorInput): AnchorResult {
  const { zoom } = viewport;
  const minX = insets.left + ANCHOR_MARGIN;
  const maxRight = container.w - insets.right - ANCHOR_MARGIN;
  const minY = insets.top + ANCHOR_MARGIN;
  const maxBottom = container.h - insets.bottom - ANCHOR_MARGIN;
  const screenLeft = viewport.x + target.x * zoom;
  const screenTop = viewport.y + target.y * zoom;
  const screenRight = screenLeft + target.w * zoom;
  const screenBottom = screenTop + target.h * zoom;

  const place = (
    left: number,
    top: number,
    side: "right" | "left",
    h: number = size.h,
  ): AnchorResult => ({
    left: Math.round(clamp(left + offset.dx, minX, maxRight - size.w)),
    top: Math.round(clamp(top + offset.dy, minY, maxBottom - h)),
    side,
  });

  const rightLeft = screenRight + ANCHOR_GAP;
  if (rightLeft + size.w <= maxRight) return place(rightLeft, screenTop, "right");
  const leftLeft = screenLeft - ANCHOR_GAP - size.w;
  if (leftLeft >= minX) return place(leftLeft, screenTop, "left");

  // Neither side fits: stack vertically, left-aligned with the target, in
  // whichever of below/above has room (below preferred), height capped to it.
  const belowTop = screenBottom + ANCHOR_GAP;
  const roomBelow = maxBottom - belowTop;
  const roomAbove = screenTop - ANCHOR_GAP - minY;
  const need = Math.min(size.h, MIN_STACK_HEIGHT);
  const useBelow = roomBelow >= size.h || (roomBelow >= need && roomBelow >= roomAbove);
  const useAbove = !useBelow && roomAbove >= need;
  if (useBelow) {
    const h = Math.min(size.h, roomBelow);
    return { ...place(screenLeft, belowTop, "right", h), maxHeight: Math.floor(roomBelow) };
  }
  if (useAbove) {
    const h = Math.min(size.h, roomAbove);
    return {
      ...place(screenLeft, screenTop - ANCHOR_GAP - h, "right", h),
      maxHeight: Math.floor(roomAbove),
    };
  }

  // Nowhere clean (tall card, small window): the old left-flip + clamp.
  return place(leftLeft, screenTop, "left");
}

/**
 * The tallest the card may render: its persisted cap, but never taller than
 * the container it has to stay inside. Without this a cap larger than the
 * canvas would leave the card permanently jammed against the clamp.
 */
export function fitHeight(cap: number, containerH: number): number {
  return Math.max(0, Math.min(cap, containerH - ANCHOR_MARGIN * 2));
}

/** Midpoint of two node boxes, as a zero-size anchor target (edge selection). */
export function midpointTarget(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: (a.x + a.w / 2 + (b.x + b.w / 2)) / 2,
    y: (a.y + a.h / 2 + (b.y + b.h / 2)) / 2,
    w: 0,
    h: 0,
  };
}
