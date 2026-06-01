/**
 * Inspector — type-dispatched config form for the selected IR node (ADR-0023).
 *
 * The IR is the source of truth: every edit dispatches `updateNodeConfig` (or
 * `updateModelParam` for nested `modelParams`) and lets the Preview pane's
 * `validate` + `compile` round-trip catch invalid IR. The UI never
 * re-implements validator invariants — schema/type-ref dropdowns just narrow
 * the choices to what `ir.schemas` actually declares (mirror of invariant 5).
 */
import type { CSSProperties } from "react";
import type {
  AgentNode,
  FunctionNode,
  GraphIR,
  GraphNode,
  HumanInputNode,
  JoinNode,
  RouterNode,
  ToolNode,
  WorkflowNode,
} from "@graphical-agents/ir";
import { useIRStore } from "../store/irStore.ts";
import type { ModelParamKey } from "../store/irReducer.ts";

// ----- shared widgets -----------------------------------------------------

const ROW: CSSProperties = { marginBottom: 10 };
const HINT: CSSProperties = { fontSize: 11, color: "#777" };

// Encoded option values for TypeRefSelect so we can round-trip null/"str"
// alongside arbitrary schema names without collisions.
const REF_NULL = "__null__";
const REF_UNSET = "__unset__";
const REF_STR = "__str__";

type RefValue = string | null | undefined;

function encodeRef(v: RefValue, hasUnset: boolean): string {
  if (v === undefined) return hasUnset ? REF_UNSET : REF_NULL;
  if (v === null) return REF_NULL;
  if (v === "str") return REF_STR;
  return `schema:${v}`;
}

function decodeRef(s: string): RefValue {
  if (s === REF_UNSET) return undefined;
  if (s === REF_NULL) return null;
  if (s === REF_STR) return "str";
  if (s.startsWith("schema:")) return s.slice("schema:".length);
  return undefined;
}

interface TypeRefSelectProps {
  id: string;
  value: RefValue;
  schemas: readonly string[];
  allowNull?: boolean;
  allowStr?: boolean;
  /** Add an "unset" option (distinct from null). */
  allowUnset?: boolean;
  onChange: (next: RefValue) => void;
}

function TypeRefSelect({
  id,
  value,
  schemas,
  allowNull = false,
  allowStr = true,
  allowUnset = false,
  onChange,
}: TypeRefSelectProps) {
  return (
    <select
      id={id}
      value={encodeRef(value, allowUnset)}
      onChange={(e) => onChange(decodeRef(e.target.value))}
    >
      {allowUnset ? <option value={REF_UNSET}>(unset)</option> : null}
      {allowNull ? <option value={REF_NULL}>null</option> : null}
      {allowStr ? <option value={REF_STR}>str</option> : null}
      {schemas.map((s) => (
        <option key={s} value={`schema:${s}`}>
          {s}
        </option>
      ))}
    </select>
  );
}

interface StringListEditorProps {
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

function StringListEditor({ value, onChange, placeholder }: StringListEditorProps) {
  return (
    <div>
      {value.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
          <input
            type="text"
            value={item}
            placeholder={placeholder}
            onChange={(e) => {
              const next = value.slice();
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...value, ""])}>
        + add
      </button>
    </div>
  );
}

interface NumberOrEmptyProps {
  id: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  step?: string;
}

function NumberOrEmpty({ id, value, onChange, step }: NumberOrEmptyProps) {
  return (
    <input
      id={id}
      type="number"
      step={step}
      value={value === undefined ? "" : value}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange(undefined);
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

interface TextAreaProps {
  id: string;
  /** `string`/`null` → null when empty (per IR `body` semantics). */
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  rows?: number;
}

function TextArea({ id, value, onChange, rows = 6 }: TextAreaProps) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === "" ? null : raw);
      }}
      style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
    />
  );
}

// ----- header -------------------------------------------------------------

function Header({ node }: { node: GraphNode }) {
  return (
    <div style={ROW}>
      <div style={{ fontWeight: 600 }}>{node.name}</div>
      <div style={HINT}>
        {node.id} · {node.type}
      </div>
    </div>
  );
}

// ----- per-type forms -----------------------------------------------------

function AgentForm({ node }: { node: AgentNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const updateModelParam = useIRStore((s) => s.updateModelParam);
  const schemas = useIRStore((s) => s.ir.schemas).map((x) => x.name);
  const params = node.config.modelParams ?? {};

  const paramRow = (key: ModelParamKey, label: string, step = "0.01") => (
    <div style={ROW}>
      <label htmlFor={`agent-${key}`}>{label}</label>
      <NumberOrEmpty
        id={`agent-${key}`}
        value={params[key]}
        step={step}
        onChange={(v) => updateModelParam(node.id, key, v)}
      />
    </div>
  );

  return (
    <div>
      <Header node={node} />

      <div style={ROW}>
        <label htmlFor="agent-model">model</label>
        <input
          id="agent-model"
          type="text"
          value={node.config.model}
          onChange={(e) => updateNodeConfig(node.id, { model: e.target.value })}
        />
      </div>

      <div style={ROW}>
        <label htmlFor="agent-mode">mode</label>
        <select
          id="agent-mode"
          value={node.config.mode ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            updateNodeConfig(node.id, { mode: v === "" ? undefined : v });
          }}
        >
          <option value="">(unset)</option>
          <option value="task">task</option>
          <option value="single_turn">single_turn</option>
        </select>
      </div>

      <div style={ROW}>
        <label htmlFor="agent-input-ref">inputSchemaRef</label>
        <TypeRefSelect
          id="agent-input-ref"
          value={node.config.inputSchemaRef}
          schemas={schemas}
          allowNull
          allowStr
          onChange={(v) => updateNodeConfig(node.id, { inputSchemaRef: v })}
        />
      </div>

      <div style={ROW}>
        <label htmlFor="agent-output-ref">outputSchemaRef</label>
        <TypeRefSelect
          id="agent-output-ref"
          value={node.config.outputSchemaRef}
          schemas={schemas}
          allowStr
          onChange={(v) =>
            updateNodeConfig(node.id, { outputSchemaRef: v ?? "str" })
          }
        />
      </div>

      {paramRow("temperature", "modelParams.temperature")}
      {paramRow("topP", "modelParams.topP")}
      {paramRow("topK", "modelParams.topK", "1")}
      {paramRow("maxOutputTokens", "modelParams.maxOutputTokens", "1")}

      <div style={ROW}>
        <label>tools</label>
        <StringListEditor
          value={node.config.tools ?? []}
          placeholder="tool name"
          onChange={(next) =>
            updateNodeConfig(node.id, { tools: next.length === 0 ? undefined : next })
          }
        />
      </div>

      <div style={ROW}>
        <label>instruction</label>
        <div style={HINT}>chip editor: Phase 2 — read-only here</div>
        <pre
          style={{
            background: "#f5f5f5",
            padding: 6,
            fontSize: 11,
            whiteSpace: "pre-wrap",
            margin: 0,
          }}
        >
          {node.config.instruction.segments
            .map((seg) =>
              seg.type === "text"
                ? seg.value
                : `<${seg.schema}.${seg.field} from ${seg.source}>`,
            )
            .join("")}
        </pre>
      </div>
    </div>
  );
}

function FunctionForm({ node }: { node: FunctionNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => s.ir.schemas).map((x) => x.name);
  return (
    <div>
      <Header node={node} />
      <div style={ROW}>
        <label htmlFor="fn-desc">description</label>
        <input
          id="fn-desc"
          type="text"
          value={node.config.description ?? ""}
          onChange={(e) =>
            updateNodeConfig(node.id, {
              description: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </div>
      <div style={ROW}>
        <label htmlFor="fn-input">inputType</label>
        <TypeRefSelect
          id="fn-input"
          value={node.config.inputType}
          schemas={schemas}
          onChange={(v) => updateNodeConfig(node.id, { inputType: v ?? "str" })}
        />
      </div>
      <div style={ROW}>
        <label htmlFor="fn-output">outputType</label>
        <TypeRefSelect
          id="fn-output"
          value={node.config.outputType}
          schemas={schemas}
          onChange={(v) => updateNodeConfig(node.id, { outputType: v ?? "str" })}
        />
      </div>
      <div style={ROW}>
        <label htmlFor="fn-emits">emits</label>
        <select
          id="fn-emits"
          value={node.config.emits ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            updateNodeConfig(node.id, { emits: v === "" ? undefined : v });
          }}
        >
          <option value="">(unset)</option>
          <option value="output">output</option>
          <option value="message">message</option>
        </select>
      </div>
      <div style={ROW}>
        <label htmlFor="fn-body">body</label>
        <div style={HINT}>empty ⇒ null (codegen emits a TODO stub)</div>
        <TextArea
          id="fn-body"
          value={node.config.body}
          onChange={(v) => updateNodeConfig(node.id, { body: v })}
        />
      </div>
    </div>
  );
}

function ToolForm({ node }: { node: ToolNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => s.ir.schemas).map((x) => x.name);
  return (
    <div>
      <Header node={node} />
      <div style={ROW}>
        <label htmlFor="tool-desc">description</label>
        <input
          id="tool-desc"
          type="text"
          value={node.config.description ?? ""}
          onChange={(e) =>
            updateNodeConfig(node.id, {
              description: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </div>
      <div style={ROW}>
        <label htmlFor="tool-input">inputType</label>
        <TypeRefSelect
          id="tool-input"
          value={node.config.inputType}
          schemas={schemas}
          onChange={(v) => updateNodeConfig(node.id, { inputType: v ?? "str" })}
        />
      </div>
      <div style={ROW}>
        <label htmlFor="tool-output">outputType</label>
        <TypeRefSelect
          id="tool-output"
          value={node.config.outputType}
          schemas={schemas}
          onChange={(v) => updateNodeConfig(node.id, { outputType: v ?? "str" })}
        />
      </div>
      <div style={ROW}>
        <label htmlFor="tool-body">body</label>
        <div style={HINT}>empty ⇒ null (codegen emits a TODO stub)</div>
        <TextArea
          id="tool-body"
          value={node.config.body}
          onChange={(v) => updateNodeConfig(node.id, { body: v })}
        />
      </div>
    </div>
  );
}

function RouterForm({ node }: { node: RouterNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => s.ir.schemas).map((x) => x.name);
  return (
    <div>
      <Header node={node} />
      <div style={ROW}>
        <label htmlFor="router-desc">description</label>
        <input
          id="router-desc"
          type="text"
          value={node.config.description ?? ""}
          onChange={(e) =>
            updateNodeConfig(node.id, {
              description: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </div>
      <div style={ROW}>
        <label>routes</label>
        <div style={HINT}>
          must match an out-edge `route` label (validator invariant 7)
        </div>
        <StringListEditor
          value={node.config.routes}
          placeholder="ROUTE_NAME"
          onChange={(next) => updateNodeConfig(node.id, { routes: next })}
        />
      </div>
      <div style={ROW}>
        <label htmlFor="router-input">inputType</label>
        <TypeRefSelect
          id="router-input"
          value={node.config.inputType}
          schemas={schemas}
          allowUnset
          onChange={(v) => updateNodeConfig(node.id, { inputType: v })}
        />
      </div>
      <div style={ROW}>
        <label htmlFor="router-body">body</label>
        <div style={HINT}>empty ⇒ null (codegen emits a TODO stub)</div>
        <TextArea
          id="router-body"
          value={node.config.body}
          onChange={(v) => updateNodeConfig(node.id, { body: v })}
        />
      </div>
    </div>
  );
}

function JoinForm({ node }: { node: JoinNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  return (
    <div>
      <Header node={node} />
      <div style={ROW}>
        <label htmlFor="join-desc">description</label>
        <input
          id="join-desc"
          type="text"
          value={node.config.description ?? ""}
          onChange={(e) =>
            updateNodeConfig(node.id, {
              description: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </div>
    </div>
  );
}

function HumanInputForm({ node }: { node: HumanInputNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => s.ir.schemas).map((x) => x.name);
  return (
    <div>
      <Header node={node} />
      <div style={ROW}>
        <label htmlFor="hi-message">message</label>
        <input
          id="hi-message"
          type="text"
          value={node.config.message}
          onChange={(e) => updateNodeConfig(node.id, { message: e.target.value })}
        />
      </div>
      <div style={ROW}>
        <label htmlFor="hi-payload">payloadRef</label>
        <TypeRefSelect
          id="hi-payload"
          value={node.config.payloadRef ?? null}
          schemas={schemas}
          allowNull
          allowStr={false}
          onChange={(v) => updateNodeConfig(node.id, { payloadRef: v ?? null })}
        />
      </div>
      <div style={ROW}>
        <label htmlFor="hi-response">responseSchemaRef</label>
        <TypeRefSelect
          id="hi-response"
          value={node.config.responseSchemaRef ?? null}
          schemas={schemas}
          allowNull
          allowStr={false}
          onChange={(v) =>
            updateNodeConfig(node.id, { responseSchemaRef: v ?? null })
          }
        />
      </div>
    </div>
  );
}

function WorkflowForm({ node }: { node: WorkflowNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const sub: GraphIR | undefined = node.config.graph;
  const nodeCount = Array.isArray(sub?.nodes) ? sub.nodes.length : 0;
  return (
    <div>
      <Header node={node} />
      <div style={ROW}>
        <label htmlFor="wf-desc">description</label>
        <input
          id="wf-desc"
          type="text"
          value={node.config.description ?? ""}
          onChange={(e) =>
            updateNodeConfig(node.id, {
              description: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </div>
      <div style={ROW}>
        <label>graph</label>
        <div style={HINT}>
          Nested workflow: {nodeCount} node{nodeCount === 1 ? "" : "s"} —
          sub-graph editing in a later slice.
        </div>
      </div>
    </div>
  );
}

// ----- edge form ----------------------------------------------------------

/**
 * EdgeForm — route-label editor for a selected edge (ADR-0027).
 *
 * If the source node is a router, render a dropdown sourced from the
 * router's own `config.routes` — same mirror-the-IR posture as the
 * schema-ref dropdowns (ADR-0023). For non-router edges, show the edge
 * metadata read-only with a note: this slice only edits router routes.
 *
 * Validity findings (route declared but no target, edge route not
 * declared, etc.) are NOT re-implemented here — the validator owns the
 * spec (invariant 7) and Preview surfaces them.
 */
function EdgeForm() {
  const selectedEdge = useIRStore((s) => s.selectedEdge)!;
  const sourceNode = useIRStore((s) =>
    s.ir.nodes.find((n) => n.id === selectedEdge.from),
  );
  const targetNode = useIRStore((s) =>
    s.ir.nodes.find((n) => n.id === selectedEdge.to),
  );
  const setEdgeRoute = useIRStore((s) => s.setEdgeRoute);

  const sourceLabel = sourceNode?.name ?? selectedEdge.from;
  const targetLabel = targetNode?.name ?? selectedEdge.to;
  const isRouterSource = sourceNode?.type === "router";

  return (
    <div>
      <div style={ROW}>
        <div style={{ fontWeight: 600 }}>
          {sourceLabel} → {targetLabel}
        </div>
        <div style={HINT}>
          edge · {isRouterSource ? "router branch" : "plain edge"}
        </div>
      </div>

      {isRouterSource ? (
        <div style={ROW}>
          <label htmlFor="edge-route">route</label>
          <div style={HINT}>
            options come from {sourceLabel}'s declared routes
            (validator invariant 7)
          </div>
          <select
            id="edge-route"
            value={selectedEdge.route ?? ""}
            onChange={(e) => {
              const next = e.target.value === "" ? undefined : e.target.value;
              setEdgeRoute(
                selectedEdge.from,
                selectedEdge.to,
                selectedEdge.route,
                next,
              );
            }}
          >
            {selectedEdge.route === undefined ||
            !sourceNode!.config.routes.includes(selectedEdge.route) ? (
              // Preserve whatever the edge currently carries (including
              // unlabeled or a route the router no longer declares) so the
              // dropdown reflects reality. Validator findings still flow
              // through Preview.
              <option value={selectedEdge.route ?? ""}>
                {selectedEdge.route ?? "(unlabeled)"}
              </option>
            ) : null}
            {sourceNode!.config.routes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div style={ROW}>
          <div style={HINT}>
            Only router out-edges carry a route label. Delete + reconnect
            to change the endpoint.
          </div>
        </div>
      )}
    </div>
  );
}

// ----- dispatch -----------------------------------------------------------

export function Inspector() {
  const selectedEdge = useIRStore((s) => s.selectedEdge);
  const node = useIRStore((s) =>
    s.selectedNodeId ? s.ir.nodes.find((n) => n.id === s.selectedNodeId) : null,
  );

  if (selectedEdge) {
    return <EdgeForm />;
  }

  if (!node) {
    return <div className="empty">Select a node or edge to edit it.</div>;
  }

  switch (node.type) {
    case "agent":
      return <AgentForm node={node} />;
    case "function":
      return <FunctionForm node={node} />;
    case "tool":
      return <ToolForm node={node} />;
    case "router":
      return <RouterForm node={node} />;
    case "join":
      return <JoinForm node={node} />;
    case "humanInput":
      return <HumanInputForm node={node} />;
    case "workflow":
      return <WorkflowForm node={node} />;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return <div className="empty">Unknown node type.</div>;
    }
  }
}
