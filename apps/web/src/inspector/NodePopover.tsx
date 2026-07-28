/**
 * NodePopover (ADR-0057) — the floating editor card that replaced the
 * Inspector pane. Clicking a node (or an edge) on the canvas pops this open
 * anchored beside it; the card holds the unchanged type-dispatched
 * `<Inspector />` form.
 *
 * Mounted as a child of `<ReactFlow>` so it can read the viewport transform
 * and position itself in screen space inside the React Flow container. The
 * `nowheel nopan nodrag` classes are React Flow's escape hatches: without
 * them, scrolling the form would zoom the canvas and dragging the card would
 * pan it.
 *
 * The anchor math lives in the dependency-free `popoverAnchor.ts` so it is
 * specced under bare `node --test`; this file is the thin React wrapper.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { useReactFlow, useStore, useViewport } from "@xyflow/react";
import { useIRStore } from "../store/irStore.ts";
import { selectActiveGraph } from "../store/subgraph.ts";
import { useUIStore } from "../layout/uiStore.ts";
import { popIn } from "../anim/presets.ts";
import { Inspector } from "./Inspector.tsx";
import { anchorPopover, fitHeight, midpointTarget } from "./popoverAnchor.ts";

/** Nominal node extents, used until React Flow has measured a node. */
const NOMINAL = { w: 180, h: 60 };

type Box = { x: number; y: number; w: number; h: number };

export function NodePopover() {
  const selectedNodeId = useIRStore((s) => s.selectedNodeId);
  const selectedEdge = useIRStore((s) => s.selectedEdge);
  const setSelectedNode = useIRStore((s) => s.setSelectedNode);
  const setSelectedEdge = useIRStore((s) => s.setSelectedEdge);
  // Node positions come from the IR (`node.ui`), so the card follows a node
  // drag — the canvas commits every intermediate position (ADR-0028).
  const graph = useIRStore(selectActiveGraph);

  const size = useUIStore((s) => s.popover);
  const setPopoverSize = useUIStore((s) => s.setPopoverSize);

  // Re-anchors on every pan/zoom and on container resize.
  const viewport = useViewport();
  const containerW = useStore((s) => s.width);
  const containerH = useStore((s) => s.height);
  const { getInternalNode } = useReactFlow();

  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  // The card hugs its content up to `size.h` (a join form is a few rows; an
  // agent form overflows), so the vertical clamp has to work off what the
  // card *actually* measures, not its cap — otherwise a short form gets
  // clamped as if it were tall and stops tracking its node.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [measuredH, setMeasuredH] = useState(size.h);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(
    null,
  );
  const resize = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );

  const close = (): void => {
    setSelectedNode(null);
    setSelectedEdge(null);
  };

  // Identity of the current selection — a change re-anchors the card, so a
  // drag offset from the previous target doesn't carry over.
  const key = selectedEdge
    ? `edge:${selectedEdge.from}|${selectedEdge.to}|${selectedEdge.route ?? ""}`
    : selectedNodeId;

  useEffect(() => {
    setOffset({ dx: 0, dy: 0 });
  }, [key]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setMeasuredH(entry.contentRect.height);
    });
    ro.observe(el);
    setMeasuredH(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, [key]);

  // Escape closes. A window listener (not one on the card) so it works while
  // focus is still on the canvas; `NodeNameInput` stops propagation on its own
  // Escape-to-revert so renaming never closes the card (ADR-0036).
  useEffect(() => {
    if (!key) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key]);

  const boxFor = (id: string): Box | null => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return null;
    const measured = getInternalNode(id)?.measured;
    return {
      x: node.ui?.x ?? 0,
      y: node.ui?.y ?? 0,
      w: measured?.width ?? NOMINAL.w,
      h: measured?.height ?? NOMINAL.h,
    };
  };

  let target: Box | null = null;
  if (selectedEdge) {
    // START is synthetic and not in `graph.nodes` (ADR-0026); when an edge
    // hangs off it, anchoring to the real end alone is close enough.
    const from = boxFor(selectedEdge.from);
    const to = boxFor(selectedEdge.to);
    target = from && to ? midpointTarget(from, to) : from ?? to;
  } else if (selectedNodeId) {
    target = boxFor(selectedNodeId);
  }

  // A selection can briefly outlive the node it points at (sub-graph swap,
  // a delete). Nothing to anchor to, so nothing to show.
  const { left, top, side } = anchorPopover({
    target: target ?? { x: 0, y: 0, w: 0, h: 0 },
    viewport,
    container: { w: containerW, h: containerH },
    size: { w: size.w, h: measuredH },
    offset,
  });

  return (
    <AnimatePresence>
      {target && (
      <m.div
        ref={cardRef}
        key="node-popover"
        className="node-popover nowheel nopan nodrag"
        data-side={side}
        style={{ left, top, width: size.w, maxHeight: fitHeight(size.h, containerH) }}
        variants={popIn}
        initial="hidden"
        animate="show"
        exit="hidden"
      >
        <div
          className="node-popover__grip"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ...offset };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            setOffset({
              dx: d.dx + (e.clientX - d.x),
              dy: d.dy + (e.clientY - d.y),
            });
          }}
          onPointerUp={(e) => {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            drag.current = null;
          }}
        >
          <span className="node-popover__grip-lines" aria-hidden="true" />
          <button
            type="button"
            className="node-popover__close"
            aria-label="Close editor"
            title="Close editor (Esc)"
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className="body inspector node-popover__body">
          <Inspector />
        </div>
        <div
          className="node-popover__resize"
          role="separator"
          aria-label="Resize editor"
          onPointerDown={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            // Height drags from what the card currently measures, so the
            // grip tracks the cursor even when the cap is above the content.
            resize.current = {
              x: e.clientX,
              y: e.clientY,
              w: size.w,
              h: measuredH,
            };
          }}
          onPointerMove={(e) => {
            const r = resize.current;
            if (!r) return;
            // Flipped to the left of the node, the card's left edge is the
            // fixed one, so dragging right must still grow it.
            const sign = side === "right" ? 1 : -1;
            setPopoverSize(
              r.w + (e.clientX - r.x) * sign,
              r.h + (e.clientY - r.y),
            );
          }}
          onPointerUp={(e) => {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            resize.current = null;
          }}
        />
      </m.div>
      )}
    </AnimatePresence>
  );
}
