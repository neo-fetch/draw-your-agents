import { AnimatePresence, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { Canvas } from "./canvas/Canvas.tsx";
import { SubgraphBreadcrumb } from "./canvas/SubgraphBreadcrumb.tsx";
import { Inspector } from "./inspector/Inspector.tsx";
import { Landing } from "./landing/Landing.tsx";
import { Palette } from "./palette/Palette.tsx";
import { Preview } from "./preview/Preview.tsx";
import { SchemaPanel } from "./schemas/SchemaPanel.tsx";
import { Toolbar } from "./toolbar/Toolbar.tsx";
import { PaneResizeHandle } from "./layout/PaneResizeHandle.tsx";
import { WorkPane } from "./layout/WorkPane.tsx";
import { pageFade, paneItem, paneStagger } from "./anim/presets.ts";
import { useTargetStore } from "./target/targetStore.ts";

/**
 * LazyMotion + `m.` components keep the motion runtime out of the main
 * bundle path; `strict` throws if a full `motion.` component sneaks in.
 * domMax (not domAnimation) because the theme switcher indicator and the
 * findings list use layout animations. `reducedMotion="user"` honors the
 * OS setting for every transform globally (ADR-0044).
 *
 * Workbench layout (ADR-0044): flex row of side panes (resizable via
 * PaneResizeHandle, collapsible to rails via WorkPane) around the canvas,
 * which always flexes to fill and never collapses.
 */
function Workbench() {
  return (
    <m.div
      className="app-shell"
      variants={pageFade}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <Toolbar />
      <m.div
        className="app"
        variants={paneStagger}
        initial="hidden"
        animate="show"
      >
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
        </WorkPane>
        <PaneResizeHandle pane="left" edge="end" />
        <m.section className="pane pane--canvas" variants={paneItem}>
          <header>Canvas</header>
          <SubgraphBreadcrumb />
          <Canvas />
        </m.section>
        <PaneResizeHandle pane="inspector" edge="start" />
        <WorkPane pane="inspector" title="Inspector" edge="end">
          <div className="body inspector">
            <Inspector />
          </div>
        </WorkPane>
        <PaneResizeHandle pane="preview" edge="start" />
        <WorkPane pane="preview" title="Preview" edge="end">
          <div className="body preview">
            <Preview />
          </div>
        </WorkPane>
      </m.div>
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
          ) : (
            <Workbench key="builder" />
          )}
        </AnimatePresence>
      </MotionConfig>
    </LazyMotion>
  );
}
