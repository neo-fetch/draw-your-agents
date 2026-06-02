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
  applyNodePosition,
  cloneFixture,
  type ModelParamKey,
} from "./irReducer.ts";
import { addNode as addNodeReducer, type AddableNodeType } from "./addNode.ts";
import {
  connectEdge as connectEdgeReducer,
  deleteEdge as deleteEdgeReducer,
  deleteNode as deleteNodeReducer,
  setEdgeRoute as setEdgeRouteReducer,
} from "./irEdges.ts";

/**
 * The triple that uniquely identifies an edge for selection purposes
 * (ADR-0027): two router out-edges may share `(from, to)` but have
 * distinct `route` labels, so a triple is the minimum needed to round-trip
 * a selection.
 */
export interface SelectedEdge {
  from: string;
  to: string;
  route?: string;
}

export interface IRState {
  ir: GraphIR;
  selectedNodeId: string | null;
  selectedEdge: SelectedEdge | null;
  setSelectedNode: (id: string | null) => void;
  setSelectedEdge: (edge: SelectedEdge | null) => void;
  /** Shallow-merge `patch` into the node's `config`, returning a new IR. */
  updateNodeConfig: (nodeId: string, patch: Record<string, unknown>) => void;
  /** Patch one nested `modelParams` key (undefined clears it). */
  updateModelParam: (
    nodeId: string,
    key: ModelParamKey,
    value: number | undefined,
  ) => void;
  /**
   * Persist a node's canvas position into `node.ui.{x,y}` (ADR-0028). The
   * canvas's drag handler dispatches this on every React Flow `position`
   * change; the reducer no-ops when the position is unchanged so idle
   * re-renders don't churn.
   */
  setNodePosition: (nodeId: string, x: number, y: number) => void;
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
  addNode: (type: AddableNodeType, position?: { x: number; y: number }) => void;
  /**
   * Append an edge. Optional `route` is for router out-edges (ADR-0027);
   * non-router edges leave it undefined.
   */
  connectEdge: (fromId: string, toId: string, route?: string) => void;
  /**
   * Relabel one router edge (ADR-0027). If the currently-selected edge
   * matches the one being relabeled, the selection's `route` is updated
   * in lockstep so the dropdown stays coherent.
   */
  setEdgeRoute: (
    fromId: string,
    toId: string,
    oldRoute: string | undefined,
    newRoute: string | undefined,
  ) => void;
  /**
   * Delete a top-level node and cascade-remove every edge that references it.
   * Clears `selectedNodeId` if it matched the removed node — selection
   * lifecycle is a store concern, not part of the pure reducer (ADR-0026).
   * Also clears `selectedEdge` if it referenced the removed node.
   */
  deleteNode: (nodeId: string) => void;
  /**
   * Remove every edge matching `{from, to}` (route-agnostic). Clears
   * `selectedEdge` if it referenced any of the removed edges.
   */
  deleteEdge: (fromId: string, toId: string) => void;
}

export type IRStore = UseBoundStore<StoreApi<IRState>>;

function edgeMatches(sel: SelectedEdge, from: string, to: string): boolean {
  return sel.from === from && sel.to === to;
}

export function createIRStore(initial: GraphIR): IRStore {
  return create<IRState>((set) => ({
    ir: initial,
    selectedNodeId: null,
    selectedEdge: null,
    setSelectedNode: (id) =>
      set((s) => ({
        selectedNodeId: id,
        // Selecting a node clears any edge selection; deselecting
        // (id === null) leaves the edge selection alone.
        selectedEdge: id === null ? s.selectedEdge : null,
      })),
    setSelectedEdge: (edge) =>
      set((s) => ({
        selectedEdge: edge,
        selectedNodeId: edge === null ? s.selectedNodeId : null,
      })),
    updateNodeConfig: (nodeId, patch) =>
      set((s) => ({ ir: applyNodeConfigPatch(s.ir, nodeId, patch) })),
    updateModelParam: (nodeId, key, value) =>
      set((s) => ({ ir: applyModelParamPatch(s.ir, nodeId, key, value) })),
    setNodePosition: (nodeId, x, y) =>
      set((s) => ({ ir: applyNodePosition(s.ir, nodeId, x, y) })),
    replaceIR: (ir) => set({ ir, selectedNodeId: null, selectedEdge: null }),
    addNode: (type, position) =>
      set((s) => {
        const { ir, nodeId } = addNodeReducer(s.ir, type, position);
        return { ir, selectedNodeId: nodeId, selectedEdge: null };
      }),
    connectEdge: (fromId, toId, route) =>
      set((s) => ({ ir: connectEdgeReducer(s.ir, fromId, toId, route) })),
    setEdgeRoute: (fromId, toId, oldRoute, newRoute) =>
      set((s) => {
        const ir = setEdgeRouteReducer(s.ir, fromId, toId, oldRoute, newRoute);
        // Keep the edge-selection coherent so the dropdown's value follows
        // the relabel without the user re-clicking the edge.
        const sel = s.selectedEdge;
        if (
          sel &&
          sel.from === fromId &&
          sel.to === toId &&
          sel.route === oldRoute
        ) {
          return { ir, selectedEdge: { from: fromId, to: toId, route: newRoute } };
        }
        return { ir };
      }),
    deleteNode: (nodeId) =>
      set((s) => {
        const ir = deleteNodeReducer(s.ir, nodeId);
        const selectedNodeId =
          s.selectedNodeId === nodeId ? null : s.selectedNodeId;
        const selectedEdge =
          s.selectedEdge &&
          (s.selectedEdge.from === nodeId || s.selectedEdge.to === nodeId)
            ? null
            : s.selectedEdge;
        return { ir, selectedNodeId, selectedEdge };
      }),
    deleteEdge: (fromId, toId) =>
      set((s) => {
        const ir = deleteEdgeReducer(s.ir, fromId, toId);
        const selectedEdge =
          s.selectedEdge && edgeMatches(s.selectedEdge, fromId, toId)
            ? null
            : s.selectedEdge;
        return { ir, selectedEdge };
      }),
  }));
}

/** App-wide singleton. The fixture is the initial state for the first slice. */
export const useIRStore: IRStore = createIRStore(
  cloneFixture(cityTime) as GraphIR,
);

// Dev-only: expose the store on window so the manual browser verification
// step in ADR-0026 can dispatch reducer actions without a UI gesture
// (chrome-devtools' synthesized keydowns don't reach React Flow's keyboard
// listener). No-op in production builds.
if (import.meta.env?.DEV) {
  (globalThis as unknown as { __ga_useIRStore?: IRStore }).__ga_useIRStore =
    useIRStore;
}
