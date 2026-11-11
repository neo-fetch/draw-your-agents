import { Handle, Position, type NodeProps } from "@xyflow/react";
import { m } from "motion/react";
import type { GraphNode } from "@graphical-agents/ir";
import { popIn } from "../anim/presets.ts";

export interface IRNodeData {
  node: GraphNode;
  selected: boolean;
  [key: string]: unknown;
}

/**
 * Mount-only pop (ADR-0044): React Flow owns node position via the wrapper
 * transform, so we animate scale/opacity on the inner card only — never x/y,
 * never `layout`. No exit animation: RF renders nodes from controlled data,
 * so AnimatePresence can't intercept removal (accepted trade-off).
 */
export function IRNode({ data }: NodeProps) {
  const { node, selected } = data as IRNodeData;
  return (
    <m.div
      className={selected ? "ir-node selected" : "ir-node"}
      data-node-type={node.type}
      variants={popIn}
      initial="hidden"
      animate="show"
    >
      <Handle type="target" position={Position.Left} />
      <div className="name">{node.name}</div>
      <div className="type">{node.type}</div>
      <Handle type="source" position={Position.Right} />
    </m.div>
  );
}
