/**
 * Headless tests for the liquid glass config (ADR-0061).
 *
 * The React wrapper (`GlassOverlayCard.tsx`) and the media-query hooks are
 * thin shims; the decisions they act on live in `glassConfig.ts` and are
 * pinned here under `node --test` (no DOM, no install).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { THEMES } from "../src/theme/themes.ts";
import {
  chooseRenderer,
  GLASS_RADIUS,
  EDGE_DISPLACEMENT,
  isChromiumBrands,
  liquidProps,
  remountKey,
} from "../src/glass/glassConfig.ts";

const styles = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");
const css = (rel: string): string => readFileSync(join(styles, rel), "utf8");

function rLg(source: string): number {
  const m = /--r-lg:\s*(\d+)px/.exec(source);
  assert.ok(m, "no --r-lg declaration found");
  return Number(m[1]);
}

test("GLASS_RADIUS mirrors each theme's --r-lg (cornerRadius can't read CSS vars)", () => {
  assert.strictEqual(GLASS_RADIUS.vellum, rLg(css("tokens.css")));
  assert.strictEqual(GLASS_RADIUS.bathory, rLg(css("themes/bathory.css")));
  for (const t of THEMES) {
    assert.ok(t.id in GLASS_RADIUS, `no glass radius for theme ${t.id}`);
  }
});

test("liquidProps: clear glass (overLight off, no extra frost) in every theme; radius per theme", () => {
  for (const t of THEMES) {
    const p = liquidProps("emptyState", t.id, { reducedMotion: false });
    assert.strictEqual(p.overLight, false, t.id); // overLight forces ≥12px frost
    assert.strictEqual(p.blurAmount, 0, t.id);
    assert.strictEqual(p.cornerRadius, GLASS_RADIUS[t.id]);
    assert.strictEqual(p.padding, "0");
  }
});

test("liquidProps: subtle edge bend on both liquid surfaces, no colour split", () => {
  for (const t of THEMES) {
    for (const surface of ["emptyState", "dropCard"] as const) {
      const p = liquidProps(surface, t.id, { reducedMotion: false });
      assert.strictEqual(p.displacementScale, EDGE_DISPLACEMENT, `${surface}/${t.id}`);
      assert.ok(EDGE_DISPLACEMENT <= 40, "edge bend must stay subtle (no stretching)");
      assert.strictEqual(p.aberrationIntensity, 0);
      assert.strictEqual(p.mode, "standard");
    }
  }
});

test("liquidProps: no elastic wobble under reduced motion, never on the drop card", () => {
  assert.ok(liquidProps("emptyState", "vellum", { reducedMotion: false }).elasticity > 0);
  assert.strictEqual(liquidProps("emptyState", "vellum", { reducedMotion: true }).elasticity, 0);
  assert.strictEqual(liquidProps("dropCard", "vellum", { reducedMotion: false }).elasticity, 0);
  assert.strictEqual(liquidProps("dropCard", "bathory", { reducedMotion: true }).elasticity, 0);
});

test("chooseRenderer: liquid only on Chromium with transparency allowed", () => {
  assert.strictEqual(chooseRenderer({ isChromium: true, reducedTransparency: false }), "liquid");
  assert.strictEqual(chooseRenderer({ isChromium: true, reducedTransparency: true }), "css");
  assert.strictEqual(chooseRenderer({ isChromium: false, reducedTransparency: false }), "css");
  assert.strictEqual(chooseRenderer({ isChromium: false, reducedTransparency: true }), "css");
});

test("isChromiumBrands detects Chromium-based browsers from userAgentData.brands", () => {
  assert.strictEqual(isChromiumBrands(undefined), false); // Safari / Firefox: no userAgentData
  assert.strictEqual(isChromiumBrands([]), false);
  assert.strictEqual(
    isChromiumBrands([{ brand: "Google Chrome" }, { brand: "Chromium" }, { brand: "Not_A Brand" }]),
    true,
  );
  assert.strictEqual(isChromiumBrands([{ brand: "Microsoft Edge" }, { brand: "Chromium" }]), true);
  assert.strictEqual(isChromiumBrands([{ brand: "Firefox" }]), false);
});

test("remountKey changes with the theme and with the font epoch", () => {
  const base = remountKey("vellum", 0);
  assert.notStrictEqual(remountKey("bathory", 0), base);
  assert.notStrictEqual(remountKey("vellum", 1), base);
  assert.strictEqual(remountKey("vellum", 0), base);
});

test("glass.css keeps its fallbacks: @supports gate and reduced-transparency off switch", () => {
  const glass = css("glass.css");
  assert.match(glass, /@supports \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  assert.match(glass, /@media \(prefers-reduced-transparency: reduce\)/);
  // the package's photo-tuned tint layers stay hidden, scoped to the host
  assert.match(glass, /\.lg-host > \.bg-black \{ display: none; \}/);
  // …and its mix-blend edge spans, which would make the overlay layer the
  // backdrop root and kill the refraction
  assert.match(glass, /\.lg-host > span \{ display: none; \}/);
  // every theme defines the glass tokens it overrides from :root
  assert.match(css("tokens.css"), /--glass-alpha:/);
  assert.match(css("themes/bathory.css"), /--glass-alpha:/);
});
