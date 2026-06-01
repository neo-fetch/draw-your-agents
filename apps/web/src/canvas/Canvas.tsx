import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Connection,
  type Edge as RFEdge,
  type EdgeChange,
  type Node as RFNode,
  type NodeChange,
} from "@xyflow/react";
import { useIRStore } from "../store/irStore.ts";
import { IRNode, type IRNodeData } from "./IRNode.tsx";
import { StartNode } from "./StartNode.tsx";

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
  const ir = useIRStore((s) => s.ir);
  const selectedNodeId = useIRStore((s) => s.selectedNodeId);
  const selectedEdge = useIRStore((s) => s.selectedEdge);
  const setSelectedNode = useIRStore((s) => s.setSelectedNode);
  const setSelectedEdge = useIRStore((s) => s.setSelectedEdge);
  const connectEdge = useIRStore((s) => s.connectEdge);
  const deleteNode = useIRStore((s) => s.deleteNode);
  const deleteEdge = useIRStore((s) => s.deleteEdge);

  // Map IR nodes to React Flow nodes, prepending the synthetic START node
  // so users can drag from it like any other source handle (ADR-0026).
  // The `selected` field is set at the RF-node top level (not inside
  // `data`) so React Flow's internal store picks it up and the Delete
  // key fires `onNodesDelete` for it.
  const rfNodes: RFNode<IRNodeData>[] = useMemo(() => {
    const start: RFNode = {
      id: START_NODE_ID,
      type: "ir-start",
      position: startNodePosition(ir.nodes),
      data: {},
      deletable: false,
      selectable: false,
      draggable: false,
    };
    const rest: RFNode<IRNodeData>[] = ir.nodes.map((n) => ({
      id: n.id,
      type: "ir",
      position: { x: n.ui?.x ?? 0, y: n.ui?.y ?? 0 },
      selected: n.id === selectedNodeId,
      data: { node: n, selected: n.id === selectedNodeId },
    }));
    return [start, ...rest];
  }, [ir.nodes, selectedNodeId]);

  // Every IR edge — including START edges — becomes a React Flow edge now
  // that START is a real (synthetic) node. `selected` drives RF's Delete
  // key handling for edges. The route is encoded in the RF id so the
  // selection-bridge round-trips back to the right IR edge (ADR-0027).
  const rfEdges: RFEdge[] = useMemo(
    () =>
      ir.edges.map((e) => {
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
    [ir.edges, selectedEdge],
  );

  // Resolve an RF edge id back to the IR edge triple. Necessary because
  // selection events only give us the id; we need (from, to, route) to
  // dispatch into the store.
  const edgeByRFId = useMemo(() => {
    const m = new Map<string, { from: string; to: string; route?: string }>();
    for (const e of ir.edges) m.set(edgeId(e.from, e.to, e.route), e);
    return m;
  }, [ir.edges]);

  // Bridge React Flow's internal selection events back into our store.
  // We only act on `select` changes — we do not handle position/dimension
  // changes because the IR owns topology and nodes are not draggable this
  // slice. Other change types are ignored, not applied; the next render
  // re-derives RF state from the IR (ADR-0026: store-not-RF-owns-edges).
  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type !== "select") continue;
      if (c.id === START_NODE_ID) continue;
      if (c.selected) setSelectedNode(c.id);
      else if (selectedNodeId === c.id) setSelectedNode(null);
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
    const source = ir.nodes.find((n) => n.id === conn.source);
    const route =
      source?.type === "router" ? source.config.routes[0] : undefined;
    connectEdge(conn.source, conn.target, route);
  };

  return (
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
      nodesDraggable={false}
      nodesConnectable={true}
      elementsSelectable
      fitView
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
