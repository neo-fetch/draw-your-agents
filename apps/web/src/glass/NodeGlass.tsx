/**
 * NodeGlass (ADR-0063) — the liquid glass layer behind a canvas node's text.
 *
 * Rendered as the first child of the `.ir-node` card (liquid renderer only;
 * `IRNode` gives the card a CSS glass fallback otherwise). It is an inset-0,
 * pointer-transparent `.lg-host` holding <LiquidGlass> centred on the card,
 * whose only child is an empty fill sized to the host with container units —
 * so the glass is exactly the card's box and the node's content, handles and
 * React Flow's measurements are untouched.
 *
 * The wobble is driven by hovering the card itself (`mouseContainer`): the
 * host ignores the pointer so clicks, drags and handle connections keep
 * working.
 */
import { useLayoutEffect, useRef } from "react";
import LiquidGlass from "liquid-glass-react";
import { liquidProps, remountKey } from "./glassConfig.ts";
import type { GlassEnv } from "./useGlassEnv.ts";

export function NodeGlass({ env }: { env: GlassEnv }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    cardRef.current = hostRef.current?.closest<HTMLElement>(".ir-node") ?? null;
  });

  return (
    <div className="lg-host lg-host--node" ref={hostRef} aria-hidden>
      <LiquidGlass
        key={remountKey(env.theme, env.fontEpoch)}
        {...liquidProps("node", env.theme, { reducedMotion: env.reducedMotion })}
        mouseContainer={cardRef}
        style={{ position: "absolute", top: "50%", left: "50%" }}
      >
        <div className="lg-fill" />
      </LiquidGlass>
    </div>
  );
}
