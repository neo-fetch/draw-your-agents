/**
 * CanvasEmptyState — guided first-run overlay (ADR-0044), shown when the IR
 * has no nodes (after "New", or loading an empty document). Pure overlay:
 * the wrapper ignores pointer events so canvas pan/drop still works; only
 * the example buttons are interactive.
 */
import { m } from "motion/react";
import { EASE_OUT } from "../anim/presets.ts";
import { EXAMPLES, loadExample } from "../store/examples.ts";
import { useIRStore } from "../store/irStore.ts";

const STEPS: ReadonlyArray<{ title: string; detail: string }> = [
  { title: "Drag a node from the palette", detail: "agents, routers, tools — drop them anywhere" },
  { title: "Wire it from START", detail: "drag between handles to connect the flow" },
  { title: "Export your ADK project", detail: "valid graphs compile to a runnable .zip" },
];

export function CanvasEmptyState() {
  const replaceIR = useIRStore((s) => s.replaceIR);

  return (
    <div className="canvas-empty" aria-hidden={false}>
      <m.div
        className="canvas-empty__card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE_OUT, delay: 0.15 }}
      >
        <div className="canvas-empty__title">Plan → working agents</div>
        <ol className="canvas-empty__steps">
          {STEPS.map((s, i) => (
            <li key={i}>
              <span className="canvas-empty__step-title">{s.title}</span>
              <span className="canvas-empty__step-detail">{s.detail}</span>
            </li>
          ))}
        </ol>
        <div className="canvas-empty__examples">
          <span className="canvas-empty__examples-label">…or start from an example</span>
          <div className="canvas-empty__examples-row">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.id}
                type="button"
                onClick={() => {
                  const result = loadExample(ex.id);
                  if (result.ok) replaceIR(result.ir);
                }}
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>
      </m.div>
    </div>
  );
}
