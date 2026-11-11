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

/** Canvas nodes use the smaller `--r-md` corner (ADR-0063); test-synced too. */
export const NODE_RADIUS: Readonly<Record<ThemeId, number>> = {
  vellum: 7,
  bathory: 1,
};

/** Surfaces that host a real <LiquidGlass>. */
export type GlassSurface = "emptyState" | "dropCard" | "node";

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
 * scales the SVG displacement map directly; its default is 70). Kept low with
 * the "standard" map so only the edges bend — at full strength a dark node
 * behind a card was stretched across its copy.
 */
export const EDGE_DISPLACEMENT = 30;

/**
 * How far a node's glass extends past the card on every side (CSS px; the
 * same value is `--node-glass-bleed` in glass.css, test-synced). The clip
 * wrapper hides it — it exists so the filter has real backdrop to sample.
 */
export const NODE_GLASS_BLEED = 12;

/**
 * Canvas nodes (ADR-0063). The package's filter shifts each pixel by up to
 * ±displacementScale/2 and samples its *own* (backdrop) image there; a node
 * is only ~50px tall, so at 60–120 most samples fell outside the glass and
 * came back empty — the glass showed for a frame (before the map decoded)
 * and then vanished. Keep the shift within the bleed.
 */
export const NODE_DISPLACEMENT = NODE_GLASS_BLEED * 2;

type Preset = Pick<
  LiquidPropsOut,
  "displacementScale" | "blurAmount" | "saturation" | "aberrationIntensity" | "elasticity" | "mode"
>;

// Subtle edge bend: the "standard" map at low strength, no chromatic split
// (with no frost, any split shows as a rainbow fringe).
const PRESETS: Readonly<Record<GlassSurface, Preset>> = {
  // Wobbles toward the cursor over the canvas.
  emptyState: { displacementScale: EDGE_DISPLACEMENT, blurAmount: 0, saturation: 170, aberrationIntensity: 0, elasticity: 0.15, mode: "standard" },
  // Static: no mousemove fires during an HTML5 drag, so elasticity is moot.
  dropCard: { displacementScale: EDGE_DISPLACEMENT, blurAmount: 0, saturation: 170, aberrationIntensity: 0, elasticity: 0, mode: "standard" },
  // Lens: the "prominent" map at moderate strength, no colour split. A light
  // wobble when hovered (the node card drives it).
  node: { displacementScale: NODE_DISPLACEMENT, blurAmount: 0, saturation: 170, aberrationIntensity: 0, elasticity: 0.1, mode: "prominent" },
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
    cornerRadius: surface === "node" ? NODE_RADIUS[theme] : GLASS_RADIUS[theme],
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
