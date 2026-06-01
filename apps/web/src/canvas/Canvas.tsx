import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
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

  // Map IR nodes to React Flow nodes, prepending the synthetic START node
  // so users can drag from it like any other source handle (ADR-0026).
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
      data: { node: n, selected: n.id === selectedNodeId },
    }));
    return [start, ...rest];
  }, [ir.nodes, selectedNodeId]);

  // Every IR edge — including START edges — becomes a React Flow edge now
  // that START is a real (synthetic) node.
  const rfEdges: RFEdge[] = useMemo(
    () =>
      ir.edges.map((e) => ({
        id: edgeId(e.from, e.to, e.route),
        source: e.from,
        target: e.to,
        label: e.route,
      })),
    [ir.edges],
  );

  const onConnect = (conn: Connection) => {
    if (!conn.source || !conn.target) return;
    connectEdge(conn.source, conn.target);
  };

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_e, n) => {
        if (n.id === START_NODE_ID) return;
        setSelectedNode(n.id);
      }}
      onPaneClick={() => setSelectedNode(null)}
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
