/**
 * Pane layout model (ADR-0044) — framework-free on purpose (no zustand, no
 * DOM) so `test/paneLayout.test.ts` runs under bare `node --test`. The
 * zustand wrapper lives in `uiStore.ts`.
 *
 * ADR-0057 removed the Inspector pane — node editing happens in a floating
 * canvas popover — so this model now covers two side panes plus the
 * popover's persisted size.
 */

export type SidePane = "left" | "preview";

export const SIDE_PANES: readonly SidePane[] = ["left", "preview"];

export const PANE_LIMITS: Record<SidePane, { min: number; max: number }> = {
  left: { min: 180, max: 320 },
  preview: { min: 360, max: 640 },
};

export const DEFAULT_WIDTHS: Record<SidePane, number> = {
  left: 240,
  preview: 484,
};

/** Collapsed panes render as a slim labeled rail. */
export const RAIL_WIDTH = 36;

export const LAYOUT_STORAGE_KEY = "ga.layout";

/** Node-popover size limits (ADR-0057) — drag-resized by its corner grip. */
export const POPOVER_LIMITS = {
  w: { min: 320, max: 640 },
  h: { min: 240, max: 900 },
};

export const DEFAULT_POPOVER: PopoverSize = { w: 380, h: 520 };

export interface PopoverSize {
  w: number;
  h: number;
}

export interface PaneLayout {
  widths: Record<SidePane, number>;
  collapsed: Record<SidePane, boolean>;
  popover: PopoverSize;
}

export function defaultLayout(): PaneLayout {
  return {
    widths: { ...DEFAULT_WIDTHS },
    collapsed: { left: false, preview: false },
    popover: { ...DEFAULT_POPOVER },
  };
}

export function clampWidth(pane: SidePane, width: number): number {
  const { min, max } = PANE_LIMITS[pane];
  if (!Number.isFinite(width)) return DEFAULT_WIDTHS[pane];
  return Math.min(max, Math.max(min, Math.round(width)));
}

function clampAxis(
  axis: "w" | "h",
  value: number,
): number {
  const { min, max } = POPOVER_LIMITS[axis];
  if (!Number.isFinite(value)) return DEFAULT_POPOVER[axis];
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampPopoverSize(size: {
  w: number;
  h: number;
}): PopoverSize {
  return { w: clampAxis("w", size.w), h: clampAxis("h", size.h) };
}

/**
 * Parse a persisted layout. Tolerates garbage, missing keys, and stale
 * shapes — anything unusable falls back to the default per-field, so a
 * schema change never strands a user on a broken layout. This is also the
 * whole migration story for ADR-0057: a payload still carrying the retired
 * `inspector` width is read through `SIDE_PANES`, so the stale key is simply
 * ignored and dropped on the next `serializeLayout`.
 */
export function parseLayout(raw: unknown): PaneLayout {
  const layout = defaultLayout();
  if (typeof raw !== "string" || raw === "") return layout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return layout;
  }
  if (typeof parsed !== "object" || parsed === null) return layout;
  const obj = parsed as Record<string, unknown>;
  const widths = obj.widths as Record<string, unknown> | undefined;
  const collapsed = obj.collapsed as Record<string, unknown> | undefined;
  for (const pane of SIDE_PANES) {
    const w = widths?.[pane];
    if (typeof w === "number") layout.widths[pane] = clampWidth(pane, w);
    const c = collapsed?.[pane];
    if (typeof c === "boolean") layout.collapsed[pane] = c;
  }
  const popover = obj.popover as Record<string, unknown> | undefined;
  if (typeof popover?.w === "number") layout.popover.w = clampAxis("w", popover.w);
  if (typeof popover?.h === "number") layout.popover.h = clampAxis("h", popover.h);
  return layout;
}

export function serializeLayout(layout: PaneLayout): string {
  return JSON.stringify({
    widths: layout.widths,
    collapsed: layout.collapsed,
    popover: layout.popover,
  });
}
