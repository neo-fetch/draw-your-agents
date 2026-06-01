/**
 * IR store — the UI's single source of truth (ADR-0001, ADR-0005, ADR-0022).
 *
 * Holds one `GraphIR` plus the current selection. Canvas, Inspector, and
 * Preview all read from here; the store is the only writer. The pure reducer
 * logic lives in `irReducer.ts` so headless tests can exercise it without
 * pulling in zustand (and without `npm install`).
 *
 * `GraphIR` is consumed type-only; the fixture is imported as JSON. Both
 * resolve in Vite and Node — no `.js`-specifier alias needed (see ADR-0022).
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { GraphIR } from "@graphical-agents/ir";
import cityTime from "../../../../packages/ir/fixtures/city-time.ir.json" with { type: "json" };
import {
  applyModelParamPatch,
  applyNodeConfigPatch,
  cloneFixture,
  type ModelParamKey,
} from "./irReducer.ts";

export interface IRState {
  ir: GraphIR;
  selectedNodeId: string | null;
  setSelectedNode: (id: string | null) => void;
  /** Shallow-merge `patch` into the node's `config`, returning a new IR. */
  updateNodeConfig: (nodeId: string, patch: Record<string, unknown>) => void;
  /** Patch one nested `modelParams` key (undefined clears it). */
  updateModelParam: (
    nodeId: string,
    key: ModelParamKey,
    value: number | undefined,
  ) => void;
  /**
   * Swap the entire IR (used by Load IR — ADR-0024). Clears the selection
   * because node ids from the loaded IR don't match the previous graph.
   */
  replaceIR: (ir: GraphIR) => void;
}

export type IRStore = UseBoundStore<StoreApi<IRState>>;

export function createIRStore(initial: GraphIR): IRStore {
  return create<IRState>((set) => ({
    ir: initial,
    selectedNodeId: null,
    setSelectedNode: (id) => set({ selectedNodeId: id }),
    updateNodeConfig: (nodeId, patch) =>
      set((s) => ({ ir: applyNodeConfigPatch(s.ir, nodeId, patch) })),
    updateModelParam: (nodeId, key, value) =>
      set((s) => ({ ir: applyModelParamPatch(s.ir, nodeId, key, value) })),
    replaceIR: (ir) => set({ ir, selectedNodeId: null }),
  }));
}

/** App-wide singleton. The fixture is the initial state for the first slice. */
export const useIRStore: IRStore = createIRStore(
  cloneFixture(cityTime) as GraphIR,
);
