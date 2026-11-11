import { AnimatePresence, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { BathoryPage } from "./bathory/BathoryPage.tsx";
import { Canvas } from "./canvas/Canvas.tsx";
import { SubgraphBreadcrumb } from "./canvas/SubgraphBreadcrumb.tsx";
import { Landing } from "./landing/Landing.tsx";
import { Palette } from "./palette/Palette.tsx";
import { Preview } from "./preview/Preview.tsx";
import { SchemaPanel } from "./schemas/SchemaPanel.tsx";
import { ToolPanel } from "./tools/ToolPanel.tsx";
import { Toolbar } from "./toolbar/Toolbar.tsx";
import { IRDropZone } from "./toolbar/IRDropZone.tsx";
import { PaneResizeHandle } from "./layout/PaneResizeHandle.tsx";
import { WorkPane } from "./layout/WorkPane.tsx";
import { CanvasWindow } from "./layout/CanvasWindow.tsx";
import FadeContent from "./anim/FadeContent.tsx";
import { MIST_REVEAL, pageFade } from "./anim/presets.ts";
import { useTargetStore } from "./target/targetStore.ts";

/**
 * LazyMotion + `m.` components keep the motion runtime out of the main
 * bundle path; `strict` throws if a full `motion.` component sneaks in.
 * domMax (not domAnimation) because the theme switcher indicator and the
 * findings list use layout animations. `reducedMotion="user"` honors the
 * OS setting for every transform globally (ADR-0044).
 *
 * Entrance (ADR-0064): the canvas, the top bar and the panes mist in one
 * after another through `FadeContent` (GSAP), the same reveal as the
 * landing page; `.fade-contents` adds no box, so the layout is unchanged.
 * motion only runs the exit fade.
 *
 * Workbench layout (ADR-0044): flex row of side panes (resizable via
 * PaneResizeHandle, collapsible to rails via WorkPane) around the canvas,
 * which always flexes to fill and never collapses. Node editing is not a
 * pane — it pops open on the canvas beside the selected node (ADR-0057).
 * A saved IR file can be dropped anywhere on it to load (ADR-0060).
 *
 * Glass workbench (ADR-0062): the canvas is mounted full-bleed *behind* the
 * top bar and both panes (`.canvas-backdrop`), which float over it as glass.
 * The flex row still lays the panes out; its middle column is a
 * pointer-transparent `CanvasWindow` that measures the visible hole so the
 * popover, controls, empty state and fit/focus stay inside it.
 */
function Workbench() {
  return (
    <m.div
      className="app-shell"
      variants={pageFade}
      initial={false}
      animate="show"
      exit="exit"
    >
      <FadeContent className="fade-contents" {...MIST_REVEAL}>
        <div className="canvas-backdrop">
          <Canvas />
        </div>
        <div className="shell-top">
          <Toolbar />
        </div>
        <IRDropZone />
        <div className="app">
          <WorkPane pane="left" title="Build" edge="start">
            <header className="pane__subhead pane__subhead--first">
              Add Node
            </header>
            <div className="body palette">
              <Palette />
            </div>
            <header className="pane__subhead">Schemas</header>
            <div className="body schemas">
              <SchemaPanel />
            </div>
            <header className="pane__subhead">Tools</header>
            <div className="body schemas">
              <ToolPanel />
            </div>
          </WorkPane>
          <PaneResizeHandle pane="left" edge="end" />
          <section className="pane pane--canvas">
            <header>Canvas</header>
            <SubgraphBreadcrumb />
            <CanvasWindow />
          </section>
          <PaneResizeHandle pane="preview" edge="start" />
          <WorkPane pane="preview" title="Preview" edge="end">
            <div className="body preview">
              <Preview />
            </div>
          </WorkPane>
        </div>
      </FadeContent>
    </m.div>
  );
}

/**
 * Phase switch instead of a router (single-file Pages build, no URL state):
 * the landing page is the front door on every load; picking a target flips
 * the target store to "builder". The graph lives in the module-level IR
 * store, so landing round-trips never lose it.
 */
export function App() {
  const phase = useTargetStore((s) => s.phase);
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <AnimatePresence mode="wait" initial={false}>
          {phase === "landing" ? (
            <Landing key="landing" />
          ) : phase === "bathory" ? (
            <BathoryPage key="bathory" />
          ) : (
            <Workbench key="builder" />
          )}
        </AnimatePresence>
      </MotionConfig>
    </LazyMotion>
  );
}
