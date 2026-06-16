/**
 * Target store — which codegen target the user picked, and whether the app
 * is on the landing page or in the builder workbench.
 *
 * Deliberately NOT persisted (unlike the theme): the landing page is the
 * front door and must show on every load. Also deliberately DOM-free
 * (unlike `themeStore`), so the install-required `test-app/` tier can
 * exercise it headlessly.
 *
 * UI-only state, separate from the IR store: the target is never part of
 * the document and never serialized into `.agentgraph.json` — the same IR
 * compiles to either target.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { DEFAULT_TARGET, type CodegenTarget } from "./targets.ts";

export type AppPhase = "landing" | "builder" | "bathory";

export interface TargetState {
  phase: AppPhase;
  target: CodegenTarget;
  /** Landing-half click: pick the target and enter the builder. */
  chooseTarget: (target: CodegenTarget) => void;
  /** In-builder switch (toolbar tag); the phase is untouched. */
  setTarget: (target: CodegenTarget) => void;
  /**
   * Open the Bathory inspiration page (the "why" behind the theme and the
   * project's ethos). Like the other phase moves, the target and IR store
   * are untouched, so the graph survives the round-trip.
   */
  showBathory: () => void;
  /**
   * Back to the landing page. The target and the IR store are untouched —
   * the graph survives the round-trip because it lives in the module-level
   * `useIRStore`. Component-local state (Preview's selected file, toolbar
   * banners) resets with the workbench unmount; that's acceptable.
   */
  returnToLanding: () => void;
}

export type TargetStore = UseBoundStore<StoreApi<TargetState>>;

export function createTargetStore(): TargetStore {
  return create<TargetState>((set) => ({
    phase: "landing",
    target: DEFAULT_TARGET,
    chooseTarget: (target) => set({ target, phase: "builder" }),
    setTarget: (target) => set({ target }),
    showBathory: () => set({ phase: "bathory" }),
    returnToLanding: () => set({ phase: "landing" }),
  }));
}

/** App-wide singleton. */
export const useTargetStore: TargetStore = createTargetStore();
