/**
 * Palette — click-to-add a fresh node of any v1 type (ADR-0025).
 *
 * Thin shim around `store.addNode(type)`. The store mints a globally-unique
 * id + name (recursing through nested `workflow.config.graph` per ADR-0017),
 * gives the node a valid-by-construction default config, and selects it so
 * the existing inspector wiring opens on it. Drag-to-canvas is intentionally
 * out of scope; click is enough to exercise the minter, which is the actual
 * hard problem this slice solves.
 *
 * The new node is unwired by design — Preview will surface the expected
 * graph-shape findings (UNREACHABLE_NODE; for routers, also
 * ROUTER_ROUTE_NO_TARGET) until the connect-edges slice lands.
 */
import type { NodeType } from "@graphical-agents/ir";
import { useIRStore } from "../store/irStore.ts";

const ENTRIES: ReadonlyArray<{ type: NodeType; label: string }> = [
  { type: "agent", label: "Agent" },
  { type: "function", label: "Function" },
  { type: "router", label: "Router" },
  { type: "tool", label: "Tool" },
  { type: "join", label: "Join" },
  { type: "humanInput", label: "Human Input" },
  { type: "workflow", label: "Workflow" },
];

export function Palette() {
  const addNode = useIRStore((s) => s.addNode);
  return (
    <ul className="palette-list">
      {ENTRIES.map(({ type, label }) => (
        <li key={type}>
          <button
            type="button"
            className="palette-item"
            data-node-type={type}
            onClick={() => addNode(type)}
            title={`Add a new ${label} node`}
          >
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}
