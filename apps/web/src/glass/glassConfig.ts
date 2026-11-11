/**
 * Liquid glass configuration (ADR-0061) — framework-free on purpose (no DOM,
 * no React) so `test/glassConfig.test.ts` runs under bare `node --test`.
 *
 * Two renderers share one look:
 *   - "liquid": `liquid-glass-react`'s <LiquidGlass> (SVG displacement +
 *     backdrop blur). Its refraction only renders in Chromium, and Safari may
 *     reject its `backdrop-filter: … url(#…)` declaration outright, so it is
 *     mounted on Chromium only.
 *   - "css": the `.glass-surface` material in `styles/glass.css` — the
 *     fallback everywhere else, and the only renderer on surfaces the package
 *     can't host (the resizable popover, inline chrome).
 * The OS is the off switch: reduced transparency → CSS (which itself goes
 * solid); reduced motion → no elastic wobble.
 */
import { type ThemeId } from "../theme/themes.ts";

/**
 * `cornerRadius` is a number prop, so it can't read `var(--r-lg)`. These
 * mirror `--r-lg` per theme; the test parses the CSS to keep them in sync.
 */
export const GLASS_RADIUS: Readonly<Record<ThemeId, number>> = {
  vellum: 11,
  bathory: 2,
};

/** Surfaces that host a real <LiquidGlass>. */
export type GlassSurface = "emptyState" | "dropCard";

export type GlassRenderer = "liquid" | "css";

/** `navigator.userAgentData.brands` → true for Chrome, Edge, Opera, Arc, … */
export function isChromiumBrands(
  brands: readonly { brand: string }[] | undefined,
): boolean {
  return brands?.some((b) => b.brand === "Chromium") ?? false;
}

export function chooseRenderer(opts: {
  reducedTransparency: boolean;
  isChromium: boolean;
}): GlassRenderer {
  return opts.isChromium && !opts.reducedTransparency ? "liquid" : "css";
}

/** The <LiquidGlass> props we set (a subset of the package's props). */
export interface LiquidPropsOut {
  overLight: boolean;
  cornerRadius: number;
  displacementScale: number;
  blurAmount: number;
  saturation: number;
  aberrationIntensity: number;
  elasticity: number;
  mode: "standard" | "polar" | "prominent";
  padding: string;
}

/**
 * Refraction strength. The package has no cap on `displacementScale` (it
 * scales the SVG displacement map directly; its default is 70).
 */
export const MAX_DISPLACEMENT = 200;

type Preset = Pick<
  LiquidPropsOut,
  "displacementScale" | "blurAmount" | "saturation" | "aberrationIntensity" | "elasticity" | "mode"
>;

// Distortion at max: "prominent" is the package's strongest stable map
// ("shader" is documented as unstable), full displacement, and a strong
// chromatic split at the edges.
const PRESETS: Readonly<Record<GlassSurface, Preset>> = {
  // Wobbles toward the cursor over the canvas.
  emptyState: { displacementScale: MAX_DISPLACEMENT, blurAmount: 0, saturation: 170, aberrationIntensity: 0, elasticity: 0.15, mode: "prominent" },
  // Static: no mousemove fires during an HTML5 drag, so elasticity is moot.
  dropCard: { displacementScale: MAX_DISPLACEMENT, blurAmount: 0, saturation: 170, aberrationIntensity: 0, elasticity: 0, mode: "prominent" },
};

export function liquidProps(
  surface: GlassSurface,
  theme: ThemeId,
  opts: { reducedMotion: boolean },
): LiquidPropsOut {
  const preset = PRESETS[surface];
  return {
    ...preset,
    elasticity: opts.reducedMotion ? 0 : preset.elasticity,
    // Clear glass in every theme: `overLight` would force ≥12px of frost
    // (and halve the displacement); off, the package's blur is 4px + 0.
    overLight: false,
    cornerRadius: GLASS_RADIUS[theme],
    // Padding lives on our own content box so it follows the theme's CSS.
    padding: "0",
  };
}

/**
 * <LiquidGlass> measures its size only on mount and window resize, so a
 * theme switch (new fonts, radius) or a late web-font load would leave its
 * edge layers the wrong size. Keying the element on both remounts it.
 */
export function remountKey(theme: ThemeId, fontEpoch: number): string {
  return `${theme}:${fontEpoch}`;
}
