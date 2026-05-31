import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "@graphical-agents/ir";

export interface IRNodeData {
  node: GraphNode;
  selected: boolean;
  [key: string]: unknown;
}

export function IRNode({ data }: NodeProps) {
  const { node, selected } = data as IRNodeData;
  return (
    <div className={selected ? "ir-node selected" : "ir-node"}>
      <Handle type="target" position={Position.Left} />
      <div className="name">{node.name}</div>
      <div className="type">{node.type}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
