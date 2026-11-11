/**
 * OS preference hooks for the glass surfaces (ADR-0061). `useSyncExternalStore`
 * over `matchMedia`, so a change in System Settings applies live.
 */
import { useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useReducedTransparency = (): boolean =>
  useMediaQuery("(prefers-reduced-transparency: reduce)");

export const useReducedMotionPref = (): boolean =>
  useMediaQuery("(prefers-reduced-motion: reduce)");
