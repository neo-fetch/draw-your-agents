/**
 * UI layout store (ADR-0044) — pane widths + collapse state. Deliberately
 * separate from the IR store: layout is workstation preference, never part
 * of the document. Persisted to localStorage on every change (tiny payload).
 */
import { create } from "zustand";
import {
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

export const useUIStore = create<UIState>((set, get) => ({
  ...readLayout(),
  resizing: null,
  setPaneWidth: (pane, width) => {
    const widths = { ...get().widths, [pane]: clampWidth(pane, width) };
    set({ widths });
    persist({ widths, collapsed: get().collapsed });
  },
  toggleCollapsed: (pane) => {
    const collapsed = { ...get().collapsed, [pane]: !get().collapsed[pane] };
    set({ collapsed });
    persist({ widths: get().widths, collapsed });
  },
  expandPane: (pane) => {
    if (!get().collapsed[pane]) return;
    const collapsed = { ...get().collapsed, [pane]: false };
    set({ collapsed });
    persist({ widths: get().widths, collapsed });
  },
  setResizing: (pane) => set({ resizing: pane }),
}));
