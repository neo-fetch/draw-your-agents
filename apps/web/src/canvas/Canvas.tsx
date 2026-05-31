import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node as RFNode,
  type Edge as RFEdge,
} from "@xyflow/react";
import { useIRStore } from "../store/irStore.ts";
import { IRNode, type IRNodeData } from "./IRNode.tsx";

const nodeTypes = { ir: IRNode };

function edgeId(from: string, to: string, route?: string): string {
  return route ? `${from}->${to}:${route}` : `${from}->${to}`;
}

export function Canvas() {
  const ir = useIRStore((s) => s.ir);
  const selectedNodeId = useIRStore((s) => s.selectedNodeId);
  const setSelectedNode = useIRStore((s) => s.setSelectedNode);

  // Map IR nodes to React Flow nodes. Read-only topology this slice.
  const rfNodes: RFNode<IRNodeData>[] = useMemo(
    () =>
      ir.nodes.map((n) => ({
        id: n.id,
        type: "ir",
        position: { x: n.ui?.x ?? 0, y: n.ui?.y ?? 0 },
        data: { node: n, selected: n.id === selectedNodeId },
      })),
    [ir.nodes, selectedNodeId],
  );

  // Drop the START sentinel — it isn't a node, only an edge source.
  const rfEdges: RFEdge[] = useMemo(
    () =>
      ir.edges
        .filter((e) => e.from !== "START")
        .map((e) => ({
          id: edgeId(e.from, e.to, e.route),
          source: e.from,
          target: e.to,
          label: e.route,
        })),
    [ir.edges],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_e, n) => setSelectedNode(n.id)}
      onPaneClick={() => setSelectedNode(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
