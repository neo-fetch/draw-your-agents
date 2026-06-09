/**
 * PaneResizeHandle — 6px drag divider between the canvas and a side pane
 * (ADR-0044). Pointer-capture drag writes widths straight to the uiStore
 * (no animation during drag); arrow keys resize in 16px steps for keyboard
 * users. Hidden while its pane is collapsed — the rail handles expand.
 */
import { useRef } from "react";
import { useUIStore } from "./uiStore.ts";
import type { SidePane } from "./paneLayout.ts";

interface Props {
  pane: SidePane;
  /** Which edge of the pane the handle touches: "end" = handle sits to the
   *  pane's right (left pane), "start" = to its left (inspector/preview). */
  edge: "start" | "end";
}

export function PaneResizeHandle({ pane, edge }: Props) {
  const collapsed = useUIStore((s) => s.collapsed[pane]);
  const width = useUIStore((s) => s.widths[pane]);
  const setPaneWidth = useUIStore((s) => s.setPaneWidth);
  const setResizing = useUIStore((s) => s.setResizing);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  if (collapsed) return null;

  const sign = edge === "end" ? 1 : -1;

  return (
    <div
      className="pane-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${pane} pane`}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width };
        setResizing(pane);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const delta = (e.clientX - drag.current.startX) * sign;
        setPaneWidth(pane, drag.current.startWidth + delta);
      }}
      onPointerUp={(e) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        drag.current = null;
        setResizing(null);
      }}
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowLeft" ? -16 * sign : e.key === "ArrowRight" ? 16 * sign : 0;
        if (step === 0) return;
        e.preventDefault();
        setPaneWidth(pane, width + step);
      }}
    />
  );
}
