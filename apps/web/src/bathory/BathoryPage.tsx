/**
 * Bathory inspiration page — the "why" behind the theme and the project's
 * ethos, lifted out of the README and into the app itself (reachable from the
 * landing footer and the toolbar).
 *
 * Phase view like Landing/Workbench (ADR-0047): App.tsx swaps it in under
 * AnimatePresence. Must use `m.` components — App mounts `LazyMotion strict`.
 *
 * The page forces `data-theme="bathory"` on its own root so the bone-white /
 * blood-red palette renders regardless of the user's active theme — the page
 * is about Bathory specifically. The wallpaper is a rotating reel of greyscale
 * late-'80s extreme-metal album sleeves (the same source the base16 palette was
 * sampled from); a dark scrim sits over it so the text stays legible.
 */
import { m } from "motion/react";
import { pageFade, paneItem, paneStagger } from "../anim/presets.ts";
import { useTargetStore } from "../target/targetStore.ts";

export function BathoryPage() {
  const returnToLanding = useTargetStore((s) => s.returnToLanding);

  return (
    <m.div
      className="bathory-page"
      data-theme="bathory"
      variants={pageFade}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <div className="bathory-page__scrim" aria-hidden="true" />
      <m.div
        className="bathory-page__inner"
        variants={paneStagger}
        initial="hidden"
        animate="show"
      >
        <m.header className="bathory-page__head" variants={paneItem}>
          <button
            type="button"
            className="bathory-page__back"
            onClick={returnToLanding}
          >
            ← back
          </button>
          <span className="bathory-page__kicker">why the theme is called</span>
          <h1 className="bathory-page__title">Bathory</h1>
        </m.header>

        <m.section className="bathory-card" variants={paneItem}>
          <h2>Free and browser-only, by design</h2>
          <p>
            Everything runs client-side: validation, code generation, the live
            preview, even the <code>.zip</code> bundler is pure TypeScript
            executing in your tab. No server, no account, no telemetry, nothing
            to pay. The project is built to be free for individuals and
            non-profits, and the AGPL-3.0 license keeps it that way — whoever
            builds on it must pass the same freedom downstream.
          </p>
        </m.section>

        <m.section className="bathory-card" variants={paneItem}>
          <h2>The theme — greyscale sleeves, one violent red</h2>
          <p>
            The wallpaper behind this page is a reel of late-1980s extreme-metal
            album covers in greyscale — and that is exactly where the look comes
            from. The palette descends from the base16{" "}
            <strong>"Black Metal (Bathory)"</strong> scheme by metalelf0, whose
            colors were lifted from that cover art: near-black paper, bone-white
            scratch lettering, ash greys, and one violent{" "}
            <span className="bathory-accent">red</span>. It is deliberately
            lo-fi and anti-commercial — sharp corners, film grain, CRT scanlines
            — a rejection of the neon, "vibrant", gamer-centric look of modern
            UI.
          </p>
        </m.section>

        <m.section className="bathory-card" variants={paneItem}>
          <h2>The band</h2>
          <p>
            <a
              href="https://en.wikipedia.org/wiki/Bathory_(band)"
              target="_blank"
              rel="noreferrer"
            >
              Bathory
            </a>
            , led by Quorthon, pioneered the first wave of black metal from
            Stockholm in the early 1980s. The early occult imagery was
            provocation aimed at religious dogmatism and institutional
            authority, not literal belief. By the late '80s Quorthon abandoned
            the Satanic aesthetic entirely and invented Viking metal:
            romanticized Norse storytelling about bravery and heritage, with
            later albums dwelling on the futility and tragedy of war rather than
            glorifying it.
          </p>
        </m.section>

        <m.section className="bathory-card" variants={paneItem}>
          <h2>The principles</h2>
          <p>
            Quorthon stood for staunch individualism and anti-authoritarianism.
            He was openly critical of herd mentality and of every ideology that
            tries to herd individuals into collectives, and he firmly rejected
            fascism and every attempt by hate groups to co-opt Norse and pagan
            imagery for white supremacy or neo-Nazism. Those principles —
            independence, skepticism of dogma, anti-war, and zero tolerance for
            hate — are what this project stands for.
          </p>
        </m.section>

        <m.footer className="bathory-page__foot" variants={paneItem}>
          In memory of Quorthon (Tomas "Ace" Börje Forsberg, 1966–2004).
        </m.footer>
      </m.div>
    </m.div>
  );
}
