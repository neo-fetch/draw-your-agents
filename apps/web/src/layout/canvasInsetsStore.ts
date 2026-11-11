/**
 * Live visible-canvas insets (ADR-0062). Written by `CanvasWindow` (which
 * measures the hole the panes leave), read by the canvas, the node popover
 * and fit/focus. Session-only — derived from layout, never persisted.
 */
import { create } from "zustand";
import { sameInsets, ZERO_INSETS, type Insets } from "./canvasInsets.ts";

interface CanvasInsetsState {
  insets: Insets;
  setInsets: (insets: Insets) => void;
}

export const useCanvasInsets = create<CanvasInsetsState>((set, get) => ({
  insets: ZERO_INSETS,
  setInsets: (insets) => {
    if (!sameInsets(get().insets, insets)) set({ insets });
  },
}));
