/**
 * A counter that bumps whenever web fonts finish loading (ADR-0061). Fraunces
 * / IBM Plex arrive after first paint and Pirata One loads on the first switch
 * to Bathory; either changes a glass card's size, which <LiquidGlass> only
 * measures on mount — so the card remounts on each bump.
 */
import { useEffect, useState } from "react";

export function useFontEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return;
    const bump = (): void => setEpoch((n) => n + 1);
    fonts.addEventListener("loadingdone", bump);
    return () => fonts.removeEventListener("loadingdone", bump);
  }, []);
  return epoch;
}
