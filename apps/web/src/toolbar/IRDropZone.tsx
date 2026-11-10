/**
 * IRDropZone — drag a saved `.agentgraph.json` anywhere onto the builder to
 * load it (ADR-0060). Same path as the Load IR button: `pickIRFile` →
 * `loadIRFromFile` → `applyLoadResult`, so the parse guard, the
 * load-then-surface policy and the banner are shared.
 *
 * Listens on `window` in the capture phase, and only for OS file drags
 * (`isFileDrag`), so:
 *   - palette node drags (custom MIME) and text drags pass straight through
 *     to the canvas and the editors;
 *   - a file dropped on a CodeMirror / Lexical editor loads the IR instead
 *     of being pasted into the editor as text;
 *   - a file dropped anywhere no longer makes the browser navigate away to
 *     the raw JSON (losing the graph).
 *
 * The overlay is `pointer-events: none` and purely visual. Mounted only in
 * the builder (Workbench), so the landing page keeps default behavior.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { isFileDrag, loadIRFromFile, pickIRFile } from "../store/irIO.ts";
import { applyLoadResult, useLoadBanner } from "./loadBanner.ts";

export function IRDropZone() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // dragenter/dragleave fire for every element crossed; a depth counter
    // tells "left the window" apart from "moved onto a child".
    let depth = 0;
    const types = (e: DragEvent): readonly string[] =>
      e.dataTransfer ? Array.from(e.dataTransfer.types) : [];

    const onEnter = (e: DragEvent): void => {
      if (!isFileDrag(types(e))) return;
      depth += 1;
      setActive(true);
    };
    const onOver = (e: DragEvent): void => {
      if (!isFileDrag(types(e))) return;
      e.preventDefault(); // allow the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent): void => {
      if (!isFileDrag(types(e))) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!isFileDrag(types(e))) return;
      e.preventDefault();
      e.stopPropagation(); // keep editors from inserting the file as text
      depth = 0;
      setActive(false);
      const picked = pickIRFile(Array.from(e.dataTransfer?.files ?? []));
      if (!picked.ok) {
        useLoadBanner.getState().setBanner({ kind: "error", message: picked.error });
        return;
      }
      void loadIRFromFile(picked.file).then(applyLoadResult);
    };

    window.addEventListener("dragenter", onEnter, true);
    window.addEventListener("dragover", onOver, true);
    window.addEventListener("dragleave", onLeave, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("dragenter", onEnter, true);
      window.removeEventListener("dragover", onOver, true);
      window.removeEventListener("dragleave", onLeave, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, []);

  return (
    <AnimatePresence>
      {active && (
        <m.div
          className="ir-drop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          aria-hidden
        >
          <div className="ir-drop__card">
            <span className="ir-drop__title">Drop to load IR</span>
            <span className="ir-drop__detail">
              .agentgraph.json / .json · replaces the current graph
            </span>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
