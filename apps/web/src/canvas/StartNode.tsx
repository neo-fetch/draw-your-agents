/**
 * Synthetic START node — rendered on the canvas as the source for entry
 * edges, but **not** present in `ir.nodes`. The IR uses the literal
 * `"START"` string as an edge `from`; the canvas materializes it as a
 * non-deletable node with id `"START"` so React Flow's `onConnect` can
 * naturally return `source: "START"` when the user drags from it
 * (ADR-0026).
 */
import { Handle, Position } from "@xyflow/react";

export function StartNode() {
  return (
    <div className="start-node">
      <span>START</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
