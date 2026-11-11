/**
 * Visible-canvas insets (ADR-0062) — framework-free (no DOM, no React) so
 * `test/canvasInsets.test.ts` runs under bare `node --test`.
 *
 * The canvas fills the whole workbench *behind* the glass top bar and side
 * panes. Everything that must stay usable — the node popover, the zoom
 * controls, the empty-state card, fit-view and focus-on-finding — works
 * against the *visible* window: the canvas rect minus these insets.
 */

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Insets of the visible window inside the full canvas, in whole px (≥ 0). */
export function computeInsets(canvas: Rect, visible: Rect): Insets {
  const px = (n: number): number => Math.max(0, Math.round(n));
  return {
    top: px(visible.top - canvas.top),
    right: px(canvas.right - visible.right),
    bottom: px(canvas.bottom - visible.bottom),
    left: px(visible.left - canvas.left),
  };
}

export function sameInsets(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** Breathing room between the fitted graph and the visible window edges. */
export const FIT_GAP = 40;

/** React Flow `fitView` padding (px per side) that frames the visible window. */
export function fitPadding(insets: Insets): {
  top: `${number}px`;
  right: `${number}px`;
  bottom: `${number}px`;
  left: `${number}px`;
} {
  const p = (n: number): `${number}px` => `${n + FIT_GAP}px`;
  return { top: p(insets.top), right: p(insets.right), bottom: p(insets.bottom), left: p(insets.left) };
}

/**
 * `setCenter(x, y)` puts a flow point at the *container* centre. To land it
 * at the visible window's centre instead, centre on this shifted point
 * (flow units: the screen shift divided by zoom).
 */
export function visibleCenterTarget(
  point: { x: number; y: number },
  insets: Insets,
  zoom: number,
): { x: number; y: number } {
  const z = zoom > 0 ? zoom : 1;
  return {
    x: point.x - (insets.left - insets.right) / 2 / z,
    y: point.y - (insets.top - insets.bottom) / 2 / z,
  };
}
