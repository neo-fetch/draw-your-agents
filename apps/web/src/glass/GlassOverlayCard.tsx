/**
 * GlassOverlayCard — a centred floating card rendered as real liquid glass
 * where the browser can (ADR-0061), else as the CSS `.glass-surface`.
 *
 * Contract: the parent is a positioned, inset-0 layer that centres its child
 * with flex (`.canvas-empty`, `.ir-drop`). In the CSS branch the card is that
 * flex child. In the liquid branch it can't be: <LiquidGlass> places each of
 * its sibling layers at top/left 50% with translate(-50%, -50%), so it gets an
 * inset-0 `.lg-host` and is positioned absolutely at the host's centre.
 *
 * Pure decisions (renderer, props, remount key) live in `glassConfig.ts`.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import LiquidGlass from "liquid-glass-react";
import { liquidProps, remountKey, type GlassSurface } from "./glassConfig.ts";
import { useGlassEnv } from "./useGlassEnv.ts";

interface Props {
  surface: GlassSurface;
  /** Classes for the card itself (size, padding, border). */
  className: string;
  /** Closest ancestor whose mouse movement drives the elastic wobble. */
  trackSelector?: string;
  children: ReactNode;
}

export function GlassOverlayCard({ surface, className, trackSelector, children }: Props) {
  const { renderer, theme, reducedMotion, fontEpoch } = useGlassEnv();
  const hostRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLElement | null>(null);

  // Resolve the mouse container before <LiquidGlass>'s passive effect attaches
  // its listener (layout effects run first). Without it the wobble only sees
  // events that bubble up from the card's own buttons, since the card is
  // pointer-transparent.
  useLayoutEffect(() => {
    trackRef.current = trackSelector
      ? (hostRef.current?.closest<HTMLElement>(trackSelector) ?? null)
      : null;
  });

  if (renderer === "css") {
    return <div className={`glass-surface ${className}`}>{children}</div>;
  }

  return (
    <div className="lg-host" ref={hostRef}>
      <LiquidGlass
        key={remountKey(theme, fontEpoch)}
        {...liquidProps(surface, theme, { reducedMotion })}
        mouseContainer={trackSelector ? trackRef : null}
        style={{ position: "absolute", top: "50%", left: "50%" }}
      >
        <div className={`lg-content ${className}`}>{children}</div>
      </LiquidGlass>
    </div>
  );
}
