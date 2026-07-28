/**
 * UI layout store (ADR-0044) — pane widths + collapse state. Deliberately
 * separate from the IR store: layout is workstation preference, never part
 * of the document. Persisted to localStorage on every change (tiny payload).
 */
import { create } from "zustand";
import {
  clampPopoverSize,
  clampWidth,
  defaultLayout,
  LAYOUT_STORAGE_KEY,
  parseLayout,
  serializeLayout,
  type PaneLayout,
  type SidePane,
} from "./paneLayout.ts";

interface UIState extends PaneLayout {
  /** Pane currently being drag-resized (disables the width transition). */
  resizing: SidePane | null;
  setPaneWidth: (pane: SidePane, width: number) => void;
  toggleCollapsed: (pane: SidePane) => void;
  expandPane: (pane: SidePane) => void;
  setResizing: (pane: SidePane | null) => void;
  /** Node-popover size, drag-resized by its corner grip (ADR-0057). */
  setPopoverSize: (w: number, h: number) => void;
}

function readLayout(): PaneLayout {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return defaultLayout();
  }
}

function persist(layout: PaneLayout): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(layout));
  } catch {
    // storage unavailable — layout still works for the session
  }
}

export const useUIStore = create<UIState>((set, get) => {
  /** Snapshot the persistable slice, with one field overridden. */
  const snapshot = (patch: Partial<PaneLayout>): PaneLayout => {
    const s = get();
    return {
      widths: patch.widths ?? s.widths,
      collapsed: patch.collapsed ?? s.collapsed,
      popover: patch.popover ?? s.popover,
    };
  };
  const commit = (patch: Partial<PaneLayout>): void => {
    const layout = snapshot(patch);
    set(patch);
    persist(layout);
  };

  return {
    ...readLayout(),
    resizing: null,
    setPaneWidth: (pane, width) =>
      commit({ widths: { ...get().widths, [pane]: clampWidth(pane, width) } }),
    toggleCollapsed: (pane) =>
      commit({
        collapsed: { ...get().collapsed, [pane]: !get().collapsed[pane] },
      }),
    expandPane: (pane) => {
      if (!get().collapsed[pane]) return;
      commit({ collapsed: { ...get().collapsed, [pane]: false } });
    },
    setResizing: (pane) => set({ resizing: pane }),
    setPopoverSize: (w, h) => commit({ popover: clampPopoverSize({ w, h }) }),
  };
});
