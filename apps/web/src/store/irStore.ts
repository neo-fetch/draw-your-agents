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
import { addNode as addNodeReducer, type AddableNodeType } from "./addNode.ts";
import {
  connectEdge as connectEdgeReducer,
  deleteEdge as deleteEdgeReducer,
  deleteNode as deleteNodeReducer,
} from "./irEdges.ts";

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
  /**
   * Append a new disconnected node of the given type to the IR (ADR-0025).
   * Mints a unique id + name across the entire IR (including nested
   * sub-graphs), selects the new node so the inspector opens on it. The
   * fresh node is unwired by design; Preview will surface the expected
   * graph-shape findings until edges land in the next slice.
   */
  addNode: (type: AddableNodeType) => void;
  /** Append a plain edge (no `route` label this slice — ADR-0026). */
  connectEdge: (fromId: string, toId: string) => void;
  /**
   * Delete a top-level node and cascade-remove every edge that references it.
   * Clears `selectedNodeId` if it matched the removed node — selection
   * lifecycle is a store concern, not part of the pure reducer (ADR-0026).
   */
  deleteNode: (nodeId: string) => void;
  /** Remove every edge matching `{from, to}` (route-agnostic). */
  deleteEdge: (fromId: string, toId: string) => void;
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
    addNode: (type) =>
      set((s) => {
        const { ir, nodeId } = addNodeReducer(s.ir, type);
        return { ir, selectedNodeId: nodeId };
      }),
    connectEdge: (fromId, toId) =>
      set((s) => ({ ir: connectEdgeReducer(s.ir, fromId, toId) })),
    deleteNode: (nodeId) =>
      set((s) => {
        const ir = deleteNodeReducer(s.ir, nodeId);
        const selectedNodeId =
          s.selectedNodeId === nodeId ? null : s.selectedNodeId;
        return { ir, selectedNodeId };
      }),
    deleteEdge: (fromId, toId) =>
      set((s) => ({ ir: deleteEdgeReducer(s.ir, fromId, toId) })),
  }));
}

/** App-wide singleton. The fixture is the initial state for the first slice. */
export const useIRStore: IRStore = createIRStore(
  cloneFixture(cityTime) as GraphIR,
);
