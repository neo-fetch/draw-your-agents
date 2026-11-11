/**
 * Shared environment for every liquid glass surface (ADR-0061/0063): which
 * renderer applies here, the theme, OS motion preference and the font epoch
 * used to remount the package after a size-changing font load.
 */
import { useThemeStore } from "../theme/themeStore.ts";
import type { ThemeId } from "../theme/themes.ts";
import { chooseRenderer, isChromiumBrands, type GlassRenderer } from "./glassConfig.ts";
import { useReducedMotionPref, useReducedTransparency } from "./useMediaQuery.ts";
import { useFontEpoch } from "./useFontEpoch.ts";

const IS_CHROMIUM = isChromiumBrands(
  (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
    .userAgentData?.brands,
);

export interface GlassEnv {
  renderer: GlassRenderer;
  theme: ThemeId;
  reducedMotion: boolean;
  fontEpoch: number;
}

export function useGlassEnv(): GlassEnv {
  const theme = useThemeStore((s) => s.theme);
  const reducedTransparency = useReducedTransparency();
  const reducedMotion = useReducedMotionPref();
  const fontEpoch = useFontEpoch();
  return {
    renderer: chooseRenderer({ reducedTransparency, isChromium: IS_CHROMIUM }),
    theme,
    reducedMotion,
    fontEpoch,
  };
}
