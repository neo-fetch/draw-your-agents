/**
 * Pane layout model (ADR-0044) — framework-free on purpose (no zustand, no
 * DOM) so `test/paneLayout.test.ts` runs under bare `node --test`. The
 * zustand wrapper lives in `uiStore.ts`.
 */

export type SidePane = "left" | "inspector" | "preview";

export const SIDE_PANES: readonly SidePane[] = ["left", "inspector", "preview"];

export const PANE_LIMITS: Record<SidePane, { min: number; max: number }> = {
  left: { min: 180, max: 320 },
  inspector: { min: 280, max: 480 },
  preview: { min: 360, max: 640 },
};

export const DEFAULT_WIDTHS: Record<SidePane, number> = {
  left: 240,
  inspector: 348,
  preview: 484,
};

/** Collapsed panes render as a slim labeled rail. */
export const RAIL_WIDTH = 36;

export const LAYOUT_STORAGE_KEY = "ga.layout";

export interface PaneLayout {
  widths: Record<SidePane, number>;
  collapsed: Record<SidePane, boolean>;
}

export function defaultLayout(): PaneLayout {
  return {
    widths: { ...DEFAULT_WIDTHS },
    collapsed: { left: false, inspector: false, preview: false },
  };
}

export function clampWidth(pane: SidePane, width: number): number {
  const { min, max } = PANE_LIMITS[pane];
  if (!Number.isFinite(width)) return DEFAULT_WIDTHS[pane];
  return Math.min(max, Math.max(min, Math.round(width)));
}

/**
 * Parse a persisted layout. Tolerates garbage, missing keys, and stale
 * shapes — anything unusable falls back to the default per-field, so a
 * schema change never strands a user on a broken layout.
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
  return layout;
}

export function serializeLayout(layout: PaneLayout): string {
  return JSON.stringify({ widths: layout.widths, collapsed: layout.collapsed });
}
