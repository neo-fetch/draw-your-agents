/**
 * Theme registry (ADR-0044) — framework-free on purpose: no zustand, no DOM,
 * no React, so the install-free `test/themes.test.ts` can import it under
 * bare `node --test`.
 *
 * A theme is (1) one entry here and (2) one `[data-theme="<id>"]` token
 * override block under `src/styles/themes/`. The CSS owns every color the
 * DOM renders; this registry carries only the values CSS can't reach:
 * the React Flow `<Background color=…>` SVG props (presentation attributes
 * don't resolve `var()`) and the `<meta name="theme-color">` content.
 *
 * The bootstrap script inlined in `index.html` duplicates THEME_STORAGE_KEY
 * and the id list so the right theme applies before any JS bundle loads —
 * keep them in sync when adding a theme.
 */

export type ThemeId = "vellum" | "bathory";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  colorScheme: "light" | "dark";
  /** `<meta name="theme-color">` content. */
  themeColor: string;
  /** React Flow canvas grid colors (SVG attrs — can't use CSS vars). */
  grid: { fine: string; coarse: string };
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: "vellum",
    label: "Vellum",
    colorScheme: "light",
    themeColor: "#f3efe6",
    grid: {
      fine: "rgba(33, 29, 24, 0.05)",
      coarse: "rgba(33, 29, 24, 0.14)",
    },
  },
  {
    id: "bathory",
    label: "Bathory",
    colorScheme: "dark",
    themeColor: "#0b0b0d",
    grid: {
      fine: "rgba(216, 211, 195, 0.05)",
      coarse: "rgba(210, 59, 34, 0.18)",
    },
  },
];

export const THEME_BY_ID: ReadonlyMap<ThemeId, ThemeMeta> = new Map(
  THEMES.map((t) => [t.id, t]),
);

export const DEFAULT_THEME: ThemeId = "vellum";
export const THEME_STORAGE_KEY = "ga.theme";

/** Narrow arbitrary (storage/dataset) input to a known theme id. */
export function coerceThemeId(value: unknown): ThemeId {
  return THEMES.some((t) => t.id === value) ? (value as ThemeId) : DEFAULT_THEME;
}
