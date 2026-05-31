import { useIRStore } from "../store/irStore.ts";

export function Inspector() {
  const selectedNodeId = useIRStore((s) => s.selectedNodeId);
  const node = useIRStore((s) =>
    s.selectedNodeId ? s.ir.nodes.find((n) => n.id === s.selectedNodeId) : null,
  );
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);

  if (!selectedNodeId || !node) {
    return <div className="empty">Select a node to edit its configuration.</div>;
  }

  if (node.type !== "agent") {
    return (
      <div className="empty">
        Inspector for <code>{node.type}</code> nodes — coming in a later slice.
      </div>
    );
  }

  // First-slice scope: edit the agent model string only (ADR-0022).
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>{node.name}</div>
        <div style={{ fontSize: 11, color: "#777" }}>{node.id} · agent</div>
      </div>
      <label htmlFor="agent-model">model</label>
      <input
        id="agent-model"
        type="text"
        value={node.config.model}
        onChange={(e) => updateNodeConfig(node.id, { model: e.target.value })}
      />
    </div>
  );
}
