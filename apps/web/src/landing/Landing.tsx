/**
 * Landing page — the front door, shown on every load: pick a codegen target
 * by clicking a half. Left = LangGraph (hover red), right = Google ADK
 * (hover blue); the recolor rides CSS `color` → the logos' `currentColor`.
 *
 * Each half is a real <button> (keyboard + focus-visible for free) that
 * dispatches `chooseTarget`, flipping the target store's phase to "builder".
 * Must use `m.` components — App.tsx mounts `LazyMotion strict`.
 */
import { m } from "motion/react";
import { pageFade, paneItem, paneStagger } from "../anim/presets.ts";
import { TARGET_BY_ID } from "../target/targets.ts";
import { useTargetStore } from "../target/targetStore.ts";
import { GoogleLogo } from "./logos/GoogleLogo.tsx";
import { LangGraphLogo } from "./logos/LangGraphLogo.tsx";

export function Landing() {
  const chooseTarget = useTargetStore((s) => s.chooseTarget);
  const langgraph = TARGET_BY_ID.get("langgraph")!;
  const adk = TARGET_BY_ID.get("adk")!;

  return (
    <m.div
      className="landing"
      variants={pageFade}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <m.div className="landing__inner" variants={paneStagger} initial="hidden" animate="show">
        <header className="landing__head">
          <span className="landing__mark">
            graphical<span className="dot">·</span>agents
          </span>
          <span className="landing__sub">draw the graph — pick where it runs</span>
        </header>
        <div className="landing__halves">
          <m.button
            type="button"
            className="landing-half landing-half--langgraph"
            variants={paneItem}
            onClick={() => chooseTarget("langgraph")}
          >
            <LangGraphLogo className="landing-half__logo" />
            <span className="landing-half__label">{langgraph.label}</span>
            <span className="landing-half__blurb">{langgraph.blurb}</span>
          </m.button>
          <m.button
            type="button"
            className="landing-half landing-half--adk"
            variants={paneItem}
            onClick={() => chooseTarget("adk")}
          >
            <GoogleLogo className="landing-half__logo" />
            <span className="landing-half__label">{adk.label}</span>
            <span className="landing-half__blurb">{adk.blurb}</span>
          </m.button>
        </div>
        <m.footer className="landing__foot" variants={paneItem}>
          runs in your browser · free for individuals &amp; non-profits · in memory of
          Quorthon — the dark theme is a{" "}
          <a
            href="https://github.com/neo-fetch/draw-your-agents#-why-bathory"
            target="_blank"
            rel="noreferrer"
          >
            tribute to Bathory
          </a>
        </m.footer>
      </m.div>
    </m.div>
  );
}
