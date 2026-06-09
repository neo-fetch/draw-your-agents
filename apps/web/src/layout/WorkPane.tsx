/**
 * WorkPane — collapsible, resizable side pane chrome (ADR-0044). The width
 * comes from the uiStore; collapse swaps the content for a slim vertical
 * rail. Width changes animate via CSS (`.pane--side` transition) except
 * during an active drag-resize. The canvas pane does not use this — it can
 * never collapse and flexes to fill.
 */
import type { ReactNode } from "react";
import { m } from "motion/react";
import { paneItem } from "../anim/presets.ts";
import { RAIL_WIDTH, type SidePane } from "./paneLayout.ts";
import { useUIStore } from "./uiStore.ts";

interface Props {
  pane: SidePane;
  /** Pane header text (and rail label when collapsed). */
  title: string;
  /** Which side of the app the pane sits on — picks the collapse glyph. */
  edge: "start" | "end";
  children: ReactNode;
}

export function WorkPane({ pane, title, edge, children }: Props) {
  const collapsed = useUIStore((s) => s.collapsed[pane]);
  const width = useUIStore((s) => s.widths[pane]);
  const resizing = useUIStore((s) => s.resizing);
  const toggleCollapsed = useUIStore((s) => s.toggleCollapsed);

  const cls = [
    "pane",
    "pane--side",
    collapsed ? "is-collapsed" : "",
    resizing === pane ? "is-resizing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <m.section
      className={cls}
      variants={paneItem}
      style={{ width: collapsed ? RAIL_WIDTH : width }}
    >
      {collapsed ? (
        <button
          type="button"
          className="pane-rail"
          title={`Expand ${title}`}
          onClick={() => toggleCollapsed(pane)}
        >
          <span className="pane-rail__label">{title}</span>
        </button>
      ) : (
        <>
          <header>
            {title}
            <button
              type="button"
              className="pane-collapse"
              aria-label={`Collapse ${title}`}
              title={`Collapse ${title}`}
              onClick={() => toggleCollapsed(pane)}
            >
              {edge === "start" ? "«" : "»"}
            </button>
          </header>
          {children}
        </>
      )}
    </m.section>
  );
}
