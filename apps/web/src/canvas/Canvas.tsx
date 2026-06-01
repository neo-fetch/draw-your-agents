import { useMemo, useState } from "react";
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
  const setSelectedNode = useIRStore((s) => s.setSelectedNode);
  const connectEdge = useIRStore((s) => s.connectEdge);
  const deleteNode = useIRStore((s) => s.deleteNode);
  const deleteEdge = useIRStore((s) => s.deleteEdge);

  // Edge selection is ephemeral UI state — track locally rather than in
  // the IR store. The IR doesn't model "selected edge"; only node
  // selection is meaningful for the inspector.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

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
  // key handling for edges.
  const rfEdges: RFEdge[] = useMemo(
    () =>
      ir.edges.map((e) => {
        const id = edgeId(e.from, e.to, e.route);
        return {
          id,
          source: e.from,
          target: e.to,
          label: e.route,
          selected: id === selectedEdgeId,
        };
      }),
    [ir.edges, selectedEdgeId],
  );

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
      if (c.selected) setSelectedEdgeId(c.id);
      else if (selectedEdgeId === c.id) setSelectedEdgeId(null);
    }
  };

  const onConnect = (conn: Connection) => {
    if (!conn.source || !conn.target) return;
    connectEdge(conn.source, conn.target);
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
        setSelectedEdgeId(null);
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
        setSelectedEdgeId(null);
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
