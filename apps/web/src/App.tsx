import { LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { Canvas } from "./canvas/Canvas.tsx";
import { Inspector } from "./inspector/Inspector.tsx";
import { Palette } from "./palette/Palette.tsx";
import { Preview } from "./preview/Preview.tsx";
import { SchemaPanel } from "./schemas/SchemaPanel.tsx";
import { Toolbar } from "./toolbar/Toolbar.tsx";
import { paneItem, paneStagger } from "./anim/presets.ts";

/**
 * LazyMotion + `m.` components keep the motion runtime out of the main
 * bundle path; `strict` throws if a full `motion.` component sneaks in.
 * domMax (not domAnimation) because the theme switcher indicator and the
 * findings list use layout animations. `reducedMotion="user"` honors the
 * OS setting for every transform globally (ADR-0044).
 */
export function App() {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <div className="app-shell">
          <Toolbar />
          <m.div
            className="app"
            variants={paneStagger}
            initial="hidden"
            animate="show"
          >
            <m.section className="pane palette-pane" variants={paneItem}>
              <header>Add Node</header>
              <div className="body palette">
                <Palette />
              </div>
              <header className="pane__subhead">Schemas</header>
              <div className="body schemas">
                <SchemaPanel />
              </div>
            </m.section>
            <m.section className="pane" variants={paneItem}>
              <header>Canvas</header>
              <Canvas />
            </m.section>
            <m.section className="pane" variants={paneItem}>
              <header>Inspector</header>
              <div className="body inspector">
                <Inspector />
              </div>
            </m.section>
            <m.section className="pane" variants={paneItem}>
              <header>Preview</header>
              <div className="body preview">
                <Preview />
              </div>
            </m.section>
          </m.div>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
