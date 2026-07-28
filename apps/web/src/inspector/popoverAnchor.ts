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
}

export interface AnchorResult {
  left: number;
  top: number;
  /** Which side of the target the popover landed on before clamping. */
  side: "right" | "left";
}

function clamp(value: number, min: number, max: number): number {
  // A popover taller/wider than its container makes max < min; pinning to the
  // top-left edge is more useful than letting the clamp invert.
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Place the popover beside the target: to its right by default, flipped to
 * the left when the right side would overrun the container. The drag offset
 * is applied *before* clamping, so a card dragged too far still snaps back
 * inside the viewport instead of disappearing.
 */
export function anchorPopover({
  target,
  viewport,
  container,
  size,
  offset,
}: AnchorInput): AnchorResult {
  const { zoom } = viewport;
  const screenLeft = viewport.x + target.x * zoom;
  const screenTop = viewport.y + target.y * zoom;
  const screenRight = screenLeft + target.w * zoom;

  const rightLeft = screenRight + ANCHOR_GAP;
  const fitsRight = rightLeft + size.w <= container.w - ANCHOR_MARGIN;
  const side: "right" | "left" = fitsRight ? "right" : "left";
  const left = fitsRight ? rightLeft : screenLeft - ANCHOR_GAP - size.w;

  return {
    left: Math.round(
      clamp(left + offset.dx, ANCHOR_MARGIN, container.w - size.w - ANCHOR_MARGIN),
    ),
    top: Math.round(
      clamp(
        screenTop + offset.dy,
        ANCHOR_MARGIN,
        container.h - size.h - ANCHOR_MARGIN,
      ),
    ),
    side,
  };
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
