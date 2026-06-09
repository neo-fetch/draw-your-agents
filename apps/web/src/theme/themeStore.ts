/**
 * Theme store (ADR-0044) — UI-only state, deliberately separate from the IR
 * store: the theme is never part of the document, never serialized into
 * `.agentgraph.json`, and the pure IR reducers stay untouched.
 *
 * The store hydrates from `document.documentElement.dataset.theme`, which the
 * inline bootstrap script in index.html has already set from localStorage —
 * so React renders in agreement with the pre-paint theme and there is no
 * flash of the wrong theme.
 *
 * `setTheme` briefly tags <html> with `.theme-switching` so the stylesheet
 * can enable color transitions for the crossfade only — permanently
 * transitioning every color property would smear unrelated UI updates.
 */
import { create } from "zustand";
import {
  coerceThemeId,
  THEME_BY_ID,
  THEME_STORAGE_KEY,
  type ThemeId,
} from "./themes.ts";

interface ThemeState {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}

const CROSSFADE_MS = 300;
let crossfadeTimer: ReturnType<typeof setTimeout> | undefined;

function applyThemeToDocument(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = THEME_BY_ID.get(id)?.themeColor;
  if (meta && color) meta.setAttribute("content", color);
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: coerceThemeId(document.documentElement.dataset.theme),
  setTheme: (id) => {
    if (id === get().theme) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (!reduceMotion) {
      document.documentElement.classList.add("theme-switching");
      clearTimeout(crossfadeTimer);
      crossfadeTimer = setTimeout(() => {
        document.documentElement.classList.remove("theme-switching");
      }, CROSSFADE_MS);
    }

    applyThemeToDocument(id);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      // storage may be unavailable (private mode) — theme still applies
    }
    set({ theme: id });
  },
}));
