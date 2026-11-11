/**
 * CanvasWindow (ADR-0062) — the empty, pointer-transparent hole in the
 * workbench row where the canvas shows through. The canvas itself is mounted
 * full-bleed behind the glass top bar and panes (`.canvas-backdrop`); this
 * element only measures the visible window and publishes its insets, so the
 * popover, controls, empty state and fit/focus stay inside it.
 */
import { useLayoutEffect, useRef } from "react";
import { computeInsets } from "./canvasInsets.ts";
import { useCanvasInsets } from "./canvasInsetsStore.ts";

export function CanvasWindow() {
  const ref = useRef<HTMLDivElement>(null);
  const setInsets = useCanvasInsets((s) => s.setInsets);

  useLayoutEffect(() => {
    const el = ref.current;
    const backdrop = document.querySelector<HTMLElement>(".canvas-backdrop");
    if (!el || !backdrop) return;
    const measure = (): void => {
      setInsets(computeInsets(backdrop.getBoundingClientRect(), el.getBoundingClientRect()));
    };
    measure();
    // Pane resize/collapse, the load banner and window resize all move the
    // window's edges; observing both boxes catches every one of them.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(backdrop);
    // Pane width animates (CSS transition) without resizing the window box
    // on every frame in all browsers — re-measure when it settles.
    const shell = el.closest(".app");
    shell?.addEventListener("transitionend", measure);
    return () => {
      ro.disconnect();
      shell?.removeEventListener("transitionend", measure);
    };
  }, [setInsets]);

  return <div className="canvas-window" ref={ref} aria-hidden />;
}
