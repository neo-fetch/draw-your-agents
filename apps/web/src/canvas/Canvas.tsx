import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  type Connection,
  type Edge as RFEdge,
  type EdgeChange,
  type Node as RFNode,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useIRStore } from "../store/irStore.ts";
import { selectActiveGraph } from "../store/subgraph.ts";
import { IRNode, type IRNodeData } from "./IRNode.tsx";
import { StartNode } from "./StartNode.tsx";
import { CanvasEmptyState } from "./CanvasEmptyState.tsx";
import { NODE_DND_MIME } from "../palette/Palette.tsx";
import type { AddableNodeType } from "../store/addNode.ts";
import { THEME_BY_ID } from "../theme/themes.ts";
import { useThemeStore } from "../theme/themeStore.ts";

const nodeTypes = { ir: IRNode, "ir-start": StartNode };

function edgeId(from: string, to: string, route?: string): string {
  return route ? `${from}->${to}:${route}` : `${from}->${to}`;
}

const START_NODE_ID = "START";

/**
 * Position the synthetic START node to the left of the existing graph,
 * lined up with the topmost real node. Falls back to the origin when
 * the IR is empty.
 */
function startNodePosition(nodes: { ui?: { x: number; y: number } }[]): {
  x: number;
  y: number;
} {
  if (nodes.length === 0) return { x: 0, y: 0 };
  let minX = Infinity;
  let yAtMinX = 0;
  for (const n of nodes) {
    const x = n.ui?.x ?? 0;
    if (x < minX) {
      minX = x;
      yAtMinX = n.ui?.y ?? 0;
    }
  }
  return { x: (minX === Infinity ? 0 : minX) - 200, y: yAtMinX };
}

export function Canvas() {
  // The canvas projects the *active* graph (ADR-0050): the root, or the
  // sub-graph of the workflow node the user zoomed into. Sub-graphs are
  // complete IRs with their own START edges and ui positions, so the
  // projection below works unchanged at any depth.
  const graph = useIRStore(selectActiveGraph);
  const subgraphPath = useIRStore((s) => s.subgraphPath);
  const enterSubgraph = useIRStore((s) => s.enterSubgraph);
  // Grid colors come from the theme registry, not CSS — React Flow's
  // <Background color> lands on SVG presentation attributes, which don't
  // resolve var() (ADR-0044).
  const theme = useThemeStore((s) => s.theme);
  const grid = THEME_BY_ID.get(theme)!.grid;
  const selectedNodeId = useIRStore((s) => s.selectedNodeId);
  const selectedEdge = useIRStore((s) => s.selectedEdge);
  const setSelectedNode = useIRStore((s) => s.setSelectedNode);
  const setSelectedEdge = useIRStore((s) => s.setSelectedEdge);
  const connectEdge = useIRStore((s) => s.connectEdge);
  const deleteNode = useIRStore((s) => s.deleteNode);
  const deleteEdge = useIRStore((s) => s.deleteEdge);
  const setNodePosition = useIRStore((s) => s.setNodePosition);
  const addNode = useIRStore((s) => s.addNode);

  // React Flow instance, captured on init so the drop handler can convert
  // screen coordinates to flow coordinates (ADR-0034). A ref (not state)
  // because nothing renders off it — it's read imperatively inside onDrop.
  const rfInstance = useRef<ReactFlowInstance<RFNode<IRNodeData>, RFEdge> | null>(
    null,
  );

  // Consume canvas focus requests from clickable findings (ADR-0043): center
  // the viewport on the requested node. Best-effort UX — no-op when the
  // instance or node is missing; `measured` is undefined before first layout,
  // so fall back to nominal half-extents. Cannot loop: `focusRequest` only
  // changes on a finding click, and `setCenter` never writes the store.
  // When `focusFinding` also switched the sub-graph (ADR-0050), React Flow
  // may not have ingested the new `nodes` prop yet — retry once on the next
  // frame before giving up.
  const focusRequest = useIRStore((s) => s.focusRequest);
  useEffect(() => {
    if (!focusRequest) return;
    const center = (retry: boolean): void => {
      const inst = rfInstance.current;
      if (!inst) return;
      const node = inst.getNode(focusRequest.nodeId);
      if (!node) {
        if (retry) requestAnimationFrame(() => center(false));
        return;
      }
      const cx = node.position.x + (node.measured?.width ?? 180) / 2;
      const cy = node.position.y + (node.measured?.height ?? 60) / 2;
      void inst.setCenter(cx, cy, { duration: 300 });
    };
    center(true);
  }, [focusRequest]);

  // Re-frame the viewport when navigating between graphs (zoom in via
  // double-click / breadcrumb jump back out). rAF: React Flow ingests the
  // new `nodes` prop in its own effect, so fitting synchronously would frame
  // the *previous* graph. Best-effort, same posture as ADR-0043.
  useEffect(() => {
    requestAnimationFrame(() => {
      void rfInstance.current?.fitView({ duration: 300 });
    });
  }, [subgraphPath]);

  // Map IR nodes to React Flow nodes, prepending the synthetic START node
  // so users can drag from it like any other source handle (ADR-0026).
  // The `selected` field is set at the RF-node top level (not inside
  // `data`) so React Flow's internal store picks it up and the Delete
  // key fires `onNodesDelete` for it.
  const rfNodes: RFNode<IRNodeData>[] = useMemo(() => {
    const start: RFNode = {
      id: START_NODE_ID,
      type: "ir-start",
      position: startNodePosition(graph.nodes),
      data: {},
      deletable: false,
      selectable: false,
      draggable: false,
    };
    const rest: RFNode<IRNodeData>[] = graph.nodes.map((n) => ({
      id: n.id,
      type: "ir",
      position: { x: n.ui?.x ?? 0, y: n.ui?.y ?? 0 },
      selected: n.id === selectedNodeId,
      data: { node: n, selected: n.id === selectedNodeId },
    }));
    return [start, ...rest];
  }, [graph.nodes, selectedNodeId]);

  // Every IR edge — including START edges — becomes a React Flow edge now
  // that START is a real (synthetic) node. `selected` drives RF's Delete
  // key handling for edges. The route is encoded in the RF id so the
  // selection-bridge round-trips back to the right IR edge (ADR-0027).
  const rfEdges: RFEdge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const id = edgeId(e.from, e.to, e.route);
        const isSelected =
          selectedEdge !== null &&
          selectedEdge.from === e.from &&
          selectedEdge.to === e.to &&
          selectedEdge.route === e.route;
        return {
          id,
          source: e.from,
          target: e.to,
          label: e.route,
          selected: isSelected,
        };
      }),
    [graph.edges, selectedEdge],
  );

  // Resolve an RF edge id back to the IR edge triple. Necessary because
  // selection events only give us the id; we need (from, to, route) to
  // dispatch into the store.
  const edgeByRFId = useMemo(() => {
    const m = new Map<string, { from: string; to: string; route?: string }>();
    for (const e of graph.edges) m.set(edgeId(e.from, e.to, e.route), e);
    return m;
  }, [graph.edges]);

  // Bridge React Flow's internal selection + drag events back into our
  // store. `select` events drive node selection (and React Flow's Delete
  // key handling). `position` events drive node-drag persistence — every
  // intermediate position is committed to `node.ui.{x,y}` so React Flow's
  // controlled-mode render reflects the drag; the reducer no-ops on
  // unchanged positions so idle re-renders don't churn (ADR-0028).
  // Dimension changes are still ignored (the IR doesn't model node size).
  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === "select") {
        if (c.id === START_NODE_ID) continue;
        if (c.selected) setSelectedNode(c.id);
        else if (selectedNodeId === c.id) setSelectedNode(null);
        continue;
      }
      if (c.type === "position") {
        if (c.id === START_NODE_ID) continue;
        if (c.position) setNodePosition(c.id, c.position.x, c.position.y);
        continue;
      }
    }
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type !== "select") continue;
      const ed = edgeByRFId.get(c.id);
      if (!ed) continue;
      if (c.selected) {
        setSelectedEdge({ from: ed.from, to: ed.to, route: ed.route });
      } else if (
        selectedEdge &&
        selectedEdge.from === ed.from &&
        selectedEdge.to === ed.to &&
        selectedEdge.route === ed.route
      ) {
        setSelectedEdge(null);
      }
    }
  };

  const onConnect = (conn: Connection) => {
    if (!conn.source || !conn.target) return;
    // If the source is a router, default to its first declared route so the
    // new edge satisfies invariant 7 immediately — the user can fix it via
    // the Inspector edge-form dropdown. If the router has no declared
    // routes (the validator would already be flagging ROUTER_NO_ROUTES),
    // leave the edge unlabeled and surface ROUTER_UNLABELED_EDGE honestly
    // (ADR-0027, follows ADR-0026's honest-surface posture).
    const source = graph.nodes.find((n) => n.id === conn.source);
    const route =
      source?.type === "router" ? source.config.routes[0] : undefined;
    connectEdge(conn.source, conn.target, route);
  };

  // --- palette drag-and-drop (ADR-0034) ---
  // The palette sets the node type on the drag's dataTransfer; the canvas is
  // the drop target. `screenToFlowPosition` maps the cursor (client coords)
  // to graph coords accounting for pan/zoom, so the node lands exactly under
  // the pointer. The store still owns the node — `addNode(type, position)`
  // mints it at the drop point (its only new capability this slice).
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(NODE_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const onDrop = (e: React.DragEvent) => {
    const type = e.dataTransfer.getData(NODE_DND_MIME);
    if (!type || !rfInstance.current) return;
    e.preventDefault();
    const position = rfInstance.current.screenToFlowPosition({
      x: e.clientX,
      y: e.clientY,
    });
    addNode(type as AddableNodeType, position);
  };

  return (
    <div className="canvas-drop" onDragOver={onDragOver} onDrop={onDrop}>
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_e, n) => {
        if (n.id === START_NODE_ID) return;
        setSelectedNode(n.id);
      }}
      onNodeDoubleClick={(_e, n) => {
        // Zoom into a workflow node's sub-graph (ADR-0050). The Inspector's
        // "Open sub-graph" button is the discoverable alternative.
        const irNode = graph.nodes.find((x) => x.id === n.id);
        if (irNode?.type === "workflow") enterSubgraph(irNode.id);
      }}
      onPaneClick={() => {
        setSelectedNode(null);
        setSelectedEdge(null);
      }}
      onConnect={onConnect}
      onNodesDelete={(nodes) => {
        for (const n of nodes) {
          if (n.id === START_NODE_ID) continue;
          deleteNode(n.id);
        }
      }}
      onEdgesDelete={(edges) => {
        for (const e of edges) deleteEdge(e.source, e.target);
      }}
      onInit={(inst) => {
        rfInstance.current = inst;
      }}
      nodesDraggable={true}
      nodesConnectable={true}
      elementsSelectable
      fitView
    >
      <Background
        id="grid-fine"
        variant={BackgroundVariant.Lines}
        gap={22}
        lineWidth={1}
        color={grid.fine}
      />
      <Background
        id="grid-coarse"
        variant={BackgroundVariant.Cross}
        gap={110}
        size={8}
        lineWidth={1.2}
        color={grid.coarse}
      />
      <Controls />
    </ReactFlow>
    {/* The example-loading empty state swaps the whole IR (`replaceIR`), so
        it only belongs at the root; an emptied sub-graph gets a hint. */}
    {graph.nodes.length === 0 &&
      (subgraphPath.length === 0 ? (
        <CanvasEmptyState />
      ) : (
        <div className="canvas-empty-subgraph">
          Empty sub-graph — add nodes from the palette.
        </div>
      ))}
    </div>
  );
}
