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
  renameNodeAt as renameNodeAtReducer,
  type ModelParamKey,
} from "./irReducer.ts";
import { addNodeAt as addNodeAtReducer, type AddableNodeType } from "./addNode.ts";
import {
  graphAtPath,
  prunePath,
  resolveFindingPath,
  updateGraphAtPath,
} from "./subgraph.ts";
import {
  connectEdge as connectEdgeReducer,
  deleteEdge as deleteEdgeReducer,
  deleteNode as deleteNodeReducer,
  setEdgeRoute as setEdgeRouteReducer,
} from "./irEdges.ts";
import {
  addField as addFieldReducer,
  addSchema as addSchemaReducer,
  deleteField as deleteFieldReducer,
  deleteSchema as deleteSchemaReducer,
  renameSchema as renameSchemaReducer,
  updateField as updateFieldReducer,
  type FieldPatch,
} from "./schemas.ts";

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
  /**
   * Workflow node ids from the root down to the sub-graph being edited
   * (ADR-0050). `[]` = the root. Canvas, palette, Inspector, and SchemaPanel
   * all operate on the graph at this path; every mutator below retargets its
   * reducer through `updateGraphAtPath`. Read sites fall back to the root
   * when the path is transiently invalid (`selectActiveGraph`).
   */
  subgraphPath: string[];
  selectedNodeId: string | null;
  selectedEdge: SelectedEdge | null;
  /**
   * One-shot canvas focus request (ADR-0043): set by `focusNode`, consumed by
   * the canvas (which centers the viewport on the node). The `nonce` bumps on
   * every call so clicking the same finding twice re-centers.
   */
  focusRequest: { nodeId: string; nonce: number } | null;
  setSelectedNode: (id: string | null) => void;
  setSelectedEdge: (edge: SelectedEdge | null) => void;
  /**
   * Select a node *and* ask the canvas to center on it (ADR-0043) — the
   * clickable-finding path. Selection semantics match `setSelectedNode`.
   * The node is looked up in the *active* graph (ADR-0050).
   */
  focusNode: (nodeId: string) => void;
  /**
   * Zoom into the sub-graph of a workflow node in the active graph
   * (ADR-0050): double-click on its canvas card or the Inspector's
   * "Open sub-graph" button. No-op when the id doesn't name a workflow node
   * there. Navigation clears both selections — they're scoped to a graph.
   */
  enterSubgraph: (workflowNodeId: string) => void;
  /**
   * Jump to an arbitrary depth (breadcrumb click). Falls back to the root
   * when the path doesn't resolve. Clears both selections.
   */
  setSubgraphPath: (path: string[]) => void;
  /**
   * Navigate to + select + center the node a validator finding points at,
   * resolving the path-prefixed nested ids ("n_outer/n_inner", ADR-0017).
   * Falls back to the deepest resolvable prefix; no-op when nothing
   * resolves. Supersedes `focusNode` for the Preview findings list.
   */
  focusFinding: (findingNodeId: string) => void;
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
   * Rename a node in the active graph and cascade every reference to its old
   * name across all nesting levels (ADR-0036, ADR-0050): var-segment `source`
   * in every agent's `instruction.segments` and every entry of every agent's
   * `config.tools[]`. Edges are id-keyed and left alone. No-op when the id is
   * unknown or the name is unchanged. Identifier validity / uniqueness is the
   * validator's job (invariant 1); Preview surfaces findings honestly.
   */
  renameNode: (nodeId: string, newName: string) => void;
  /**
   * Swap the entire IR (used by Load IR — ADR-0024). Clears the selection
   * and resets `subgraphPath` because node ids from the loaded IR don't
   * match the previous graph.
   */
  replaceIR: (ir: GraphIR) => void;
  /**
   * Append a new disconnected node of the given type to the active graph
   * (ADR-0025, ADR-0050). Mints a unique id + name across the entire root IR
   * (including nested sub-graphs), selects the new node so the inspector
   * opens on it. The fresh node is unwired by design; Preview will surface
   * the expected graph-shape findings until the user connects it.
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
   * Delete a node from the active graph and cascade-remove every edge that
   * references it. Clears `selectedNodeId` if it matched the removed node —
   * selection lifecycle is a store concern, not part of the pure reducer
   * (ADR-0026). Also clears `selectedEdge` if it referenced the removed node.
   */
  deleteNode: (nodeId: string) => void;
  /**
   * Remove every edge matching `{from, to}` (route-agnostic). Clears
   * `selectedEdge` if it referenced any of the removed edges.
   */
  deleteEdge: (fromId: string, toId: string) => void;
  /** Append a new schema with one default `field1: str` (ADR-0035). */
  addSchema: () => void;
  /**
   * Rename a schema in the active graph and cascade every reference there
   * (agent / function / router / tool / humanInput refs + agent var-chip
   * `schema` fields). Active-graph-only is *complete*: schema refs resolve
   * strictly per-level in the validator, so no cross-level reference can
   * exist (ADR-0050). No-op when `newName === oldName` or the schema doesn't
   * exist.
   */
  renameSchema: (oldName: string, newName: string) => void;
  /**
   * Remove a schema. Leaves references dangling for the validator to surface
   * (honest-surface posture).
   */
  deleteSchema: (name: string) => void;
  /** Append `field{N}: str` to a named schema. */
  addField: (schemaName: string) => void;
  /** Patch one field's name / type / optional. */
  updateField: (
    schemaName: string,
    fieldName: string,
    patch: FieldPatch,
  ) => void;
  /** Remove a field from a schema. */
  deleteField: (schemaName: string, fieldName: string) => void;
}

export type IRStore = UseBoundStore<StoreApi<IRState>>;

function edgeMatches(sel: SelectedEdge, from: string, to: string): boolean {
  return sel.from === from && sel.to === to;
}

export function createIRStore(initial: GraphIR): IRStore {
  return create<IRState>((set) => ({
    ir: initial,
    subgraphPath: [],
    selectedNodeId: null,
    selectedEdge: null,
    focusRequest: null,
    focusNode: (nodeId) =>
      set((s) => ({
        selectedNodeId: nodeId,
        selectedEdge: null,
        focusRequest: { nodeId, nonce: (s.focusRequest?.nonce ?? 0) + 1 },
      })),
    enterSubgraph: (workflowNodeId) =>
      set((s) => {
        const path = [...s.subgraphPath, workflowNodeId];
        if (!graphAtPath(s.ir, path)) return {};
        return { subgraphPath: path, selectedNodeId: null, selectedEdge: null };
      }),
    setSubgraphPath: (path) =>
      set((s) => ({
        subgraphPath: graphAtPath(s.ir, path) ? path : [],
        selectedNodeId: null,
        selectedEdge: null,
      })),
    focusFinding: (findingNodeId) =>
      set((s) => {
        const loc = resolveFindingPath(s.ir, findingNodeId);
        if (!loc) return {};
        return {
          subgraphPath: loc.path,
          selectedNodeId: loc.nodeId,
          selectedEdge: null,
          focusRequest: {
            nodeId: loc.nodeId,
            nonce: (s.focusRequest?.nonce ?? 0) + 1,
          },
        };
      }),
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
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          applyNodeConfigPatch(g, nodeId, patch),
        ),
      })),
    updateModelParam: (nodeId, key, value) =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          applyModelParamPatch(g, nodeId, key, value),
        ),
      })),
    setNodePosition: (nodeId, x, y) =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          applyNodePosition(g, nodeId, x, y),
        ),
      })),
    renameNode: (nodeId, newName) =>
      set((s) => ({
        ir: renameNodeAtReducer(s.ir, s.subgraphPath, nodeId, newName),
      })),
    replaceIR: (ir) =>
      set({ ir, subgraphPath: [], selectedNodeId: null, selectedEdge: null }),
    addNode: (type, position) =>
      set((s) => {
        const { ir, nodeId } = addNodeAtReducer(
          s.ir,
          s.subgraphPath,
          type,
          position,
        );
        if (ir === s.ir) return {};
        return { ir, selectedNodeId: nodeId, selectedEdge: null };
      }),
    connectEdge: (fromId, toId, route) =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          connectEdgeReducer(g, fromId, toId, route),
        ),
      })),
    setEdgeRoute: (fromId, toId, oldRoute, newRoute) =>
      set((s) => {
        const ir = updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          setEdgeRouteReducer(g, fromId, toId, oldRoute, newRoute),
        );
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
        const ir = updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          deleteNodeReducer(g, nodeId),
        );
        const selectedNodeId =
          s.selectedNodeId === nodeId ? null : s.selectedNodeId;
        const selectedEdge =
          s.selectedEdge &&
          (s.selectedEdge.from === nodeId || s.selectedEdge.to === nodeId)
            ? null
            : s.selectedEdge;
        // Defensive: unreachable from the UI (the workflow you're inside is
        // not in the active graph's nodes), but the dev-window store can
        // dispatch a delete of an ancestor — don't strand the path.
        const subgraphPath = prunePath(s.subgraphPath, nodeId) as string[];
        return { ir, selectedNodeId, selectedEdge, subgraphPath };
      }),
    deleteEdge: (fromId, toId) =>
      set((s) => {
        const ir = updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          deleteEdgeReducer(g, fromId, toId),
        );
        const selectedEdge =
          s.selectedEdge && edgeMatches(s.selectedEdge, fromId, toId)
            ? null
            : s.selectedEdge;
        return { ir, selectedEdge };
      }),
    addSchema: () =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) => addSchemaReducer(g).ir),
      })),
    renameSchema: (oldName, newName) =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          renameSchemaReducer(g, oldName, newName),
        ),
      })),
    deleteSchema: (name) =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          deleteSchemaReducer(g, name),
        ),
      })),
    addField: (schemaName) =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          addFieldReducer(g, schemaName),
        ),
      })),
    updateField: (schemaName, fieldName, patch) =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          updateFieldReducer(g, schemaName, fieldName, patch),
        ),
      })),
    deleteField: (schemaName, fieldName) =>
      set((s) => ({
        ir: updateGraphAtPath(s.ir, s.subgraphPath, (g) =>
          deleteFieldReducer(g, schemaName, fieldName),
        ),
      })),
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
