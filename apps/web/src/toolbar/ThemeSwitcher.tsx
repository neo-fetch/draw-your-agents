/**
 * ThemeSwitcher — segmented control over the theme registry (ADR-0044).
 * Segments are generated from THEMES, so registering a new theme adds a
 * segment with no component change.
 */
import { THEMES } from "../theme/themes.ts";
import { useThemeStore } from "../theme/themeStore.ts";

export function ThemeSwitcher() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="theme-switcher" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={t.id === theme}
          className={
            t.id === theme ? "theme-switcher__seg is-active" : "theme-switcher__seg"
          }
          onClick={() => setTheme(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
