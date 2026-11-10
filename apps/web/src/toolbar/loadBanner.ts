/**
 * Load banner state (ADR-0024, lifted out of `Toolbar.tsx` by ADR-0060).
 *
 * The banner used to be Toolbar-local state; the IR drop zone also loads
 * files, so the banner and the "apply a load result" policy now live here
 * and both entry points (Load IR picker, drag-and-drop) share them.
 */
import { create } from "zustand";
import { useIRStore } from "../store/irStore.ts";
import type { LoadResult } from "../store/irIO.ts";

export type Banner =
  | { kind: "none" }
  | { kind: "load-findings"; count: number }
  | { kind: "error"; message: string };

interface LoadBannerState {
  banner: Banner;
  setBanner: (banner: Banner) => void;
}

export const useLoadBanner = create<LoadBannerState>((set) => ({
  banner: { kind: "none" },
  setBanner: (banner) => set({ banner }),
}));

/**
 * Apply a load result with the "load-then-surface, don't gate" policy
 * (ADR-0024): a rejected file only shows the error; an accepted one replaces
 * the IR and shows the findings count when there is one.
 */
export function applyLoadResult(result: LoadResult): void {
  const { setBanner } = useLoadBanner.getState();
  if (!result.ok) {
    setBanner({ kind: "error", message: result.error });
    return;
  }
  useIRStore.getState().replaceIR(result.ir);
  setBanner(
    result.findings.length > 0
      ? { kind: "load-findings", count: result.findings.length }
      : { kind: "none" },
  );
}
