import { Handle, Position, type NodeProps } from "@xyflow/react";
import { m } from "motion/react";
import type { GraphNode } from "@graphical-agents/ir";
import { popIn } from "../anim/presets.ts";
import { NodeGlass } from "../glass/NodeGlass.tsx";
import { useGlassEnv } from "../glass/useGlassEnv.ts";

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
 *
 * The card is liquid glass (ADR-0063): a `NodeGlass` layer sits behind the
 * text where the browser supports it; elsewhere the card falls back to the
 * CSS glass material.
 */
export function IRNode({ data }: NodeProps) {
  const { node, selected } = data as IRNodeData;
  const env = useGlassEnv();
  const liquid = env.renderer === "liquid";
  const cls = ["ir-node", liquid ? "ir-node--liquid" : "", selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <m.div
      className={cls}
      data-node-type={node.type}
      variants={popIn}
      initial="hidden"
      animate="show"
    >
      {liquid && <NodeGlass env={env} />}
      <Handle type="target" position={Position.Left} />
      <div className="name">{node.name}</div>
      <div className="type">{node.type}</div>
      <Handle type="source" position={Position.Right} />
    </m.div>
  );
}
