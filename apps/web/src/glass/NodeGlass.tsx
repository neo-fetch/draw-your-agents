/**
 * NodeGlass (ADR-0063) — the liquid glass layer behind a canvas node's text.
 *
 * Rendered as the first child of the `.ir-node` card (liquid renderer only;
 * `IRNode` gives the card a CSS glass fallback otherwise). A clip wrapper
 * (inset 0, the card's radius) holds a pointer-transparent `.lg-host` that
 * bleeds `--node-glass-bleed` past the card on every side, with <LiquidGlass>
 * centred in it and an empty fill sized to the host with container units.
 * The bleed gives the displacement filter real backdrop to sample near the
 * card's edges; the clip keeps the visible glass exactly the card's box. The
 * node's content, handles and React Flow's measurements are untouched.
 *
 * The wobble is driven by hovering the card itself (`mouseContainer`): the
 * host ignores the pointer so clicks, drags and handle connections keep
 * working.
 */
import { useLayoutEffect, useRef } from "react";
import LiquidGlass from "liquid-glass-react";
import { liquidProps } from "./glassConfig.ts";
import type { GlassEnv } from "./useGlassEnv.ts";

export function NodeGlass({ env }: { env: GlassEnv }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    cardRef.current = hostRef.current?.closest<HTMLElement>(".ir-node") ?? null;
  });

  return (
    <div className="lg-clip" aria-hidden>
      <div className="lg-host lg-host--node" ref={hostRef}>
        {/* No remount key: the svg is pinned by CSS (glass.css) and props
            update in place, so a font load elsewhere (opening the popover
            loads the editor font) must not tear down every node's glass. */}
        <LiquidGlass
          {...liquidProps("node", env.theme, { reducedMotion: env.reducedMotion })}
          mouseContainer={cardRef}
          style={{ position: "absolute", top: "50%", left: "50%" }}
        >
          <div className="lg-fill" />
        </LiquidGlass>
      </div>
    </div>
  );
}
