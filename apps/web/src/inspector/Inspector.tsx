/**
 * Inspector — type-dispatched config form for the selected IR node (ADR-0023).
 *
 * The IR is the source of truth: every edit dispatches `updateNodeConfig` (or
 * `updateModelParam` for nested `modelParams`) and lets the Preview pane's
 * `validate` + `compile` round-trip catch invalid IR. The UI never
 * re-implements validator invariants — schema/type-ref dropdowns just narrow
 * the choices to what `ir.schemas` actually declares (mirror of invariant 5).
 */
import type {
  AgentNode,
  FunctionNode,
  GraphIR,
  GraphNode,
  HumanInputNode,
  JoinNode,
  LoopNode,
  LoopSubAgent,
  RouterNode,
  ToolNode,
  WorkflowNode,
} from "@graphical-agents/ir";
import { useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";
import { useIRStore } from "../store/irStore.ts";
import { selectActiveGraph } from "../store/subgraph.ts";
import type { ModelParamKey } from "../store/irReducer.ts";
import { formSwap } from "../anim/presets.ts";
import { VariableEditor, type VariableEditorAPI } from "./VariableEditor.tsx";
import { VariablePalette } from "./VariablePalette.tsx";

// ----- shared widgets -----------------------------------------------------

// Form rows/hints use the `.field` / `.field__hint` classes (inspector.css)
// so themes restyle them through tokens.

/** Grouped form block — small-caps legend matching the pane subhead voice. */
function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="form-section">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

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
        <div key={i} className="list-row">
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
    />
  );
}

// ----- header -------------------------------------------------------------

/**
 * Commit-on-blur name editor for the selected node (ADR-0036). Local buffer
 * so a half-typed name like "lookup_tim" doesn't dispatch a rename cascade +
 * a parade of `INVALID_NODE_NAME` findings on every keystroke — same posture
 * as the schema panel's `NameInput` (ADR-0035). Parent keys the wrapper on
 * `node.id` so a node-selection switch remounts with fresh `initial`.
 */
function NodeNameInput({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      aria-label="node name"
      value={value}
      className="field__name-input"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value !== initial) onCommit(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setValue(initial);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * Sticky mini-header (ADR-0044): node name + type chip stay visible while
 * scrolling long forms — the chip is tinted with the node-type hue.
 */
function Header({ node }: { node: GraphNode }) {
  const renameNode = useIRStore((s) => s.renameNode);
  return (
    <div className="form-head" data-node-type={node.type}>
      <NodeNameInput
        key={node.id}
        initial={node.name}
        onCommit={(next) => renameNode(node.id, next)}
      />
      <div className="form-head__meta">
        <span className="type-chip">{node.type}</span>
        <span className="field__hint">{node.id}</span>
      </div>
    </div>
  );
}

// ----- per-type forms -----------------------------------------------------

function AgentForm({ node }: { node: AgentNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const updateModelParam = useIRStore((s) => s.updateModelParam);
  const schemas = useIRStore((s) => selectActiveGraph(s).schemas).map((x) => x.name);
  const params = node.config.modelParams ?? {};

  // Imperative handle into the Lexical editor for chip insertion (ADR-0030).
  // The palette button click blurs the editor and collapses the selection,
  // so `VariableEditor` snapshots the last RangeSelection and the insert
  // call restores it; fallback is `selectEnd()` (PHASE-2-DESIGN trap).
  // Per-node ref — `key={node.id}` remounts the editor and clears any
  // stale handle on agent switch.
  const editorApiRef = useRef<VariableEditorAPI | null>(null);

  const paramRow = (key: ModelParamKey, label: string, step = "0.01") => (
    <div className="field">
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

      <FormSection title="Model">
        <div className="field">
          <label htmlFor="agent-model">model</label>
          <input
            id="agent-model"
            type="text"
            value={node.config.model}
            onChange={(e) => updateNodeConfig(node.id, { model: e.target.value })}
          />
        </div>

        <div className="field">
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

        {paramRow("temperature", "modelParams.temperature")}
        {paramRow("topP", "modelParams.topP")}
        {paramRow("topK", "modelParams.topK", "1")}
        {paramRow("maxOutputTokens", "modelParams.maxOutputTokens", "1")}
      </FormSection>

      <FormSection title="Input · Output">
        <div className="field">
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

        <div className="field">
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

        <div className="field">
          <label>tools</label>
          <StringListEditor
            value={node.config.tools ?? []}
            placeholder="tool name"
            onChange={(next) =>
              updateNodeConfig(node.id, { tools: next.length === 0 ? undefined : next })
            }
          />
        </div>
      </FormSection>

      <FormSection title="Prompt">
      <div className="field">
        <label>instruction</label>
        <div className="field__hint">
          editable prompt — existing variable chips are atomic
          (backspace deletes a whole chip). Use the palette below to
          insert a producer field at the caret.
        </div>
        {/*
          Seed-once-per-node: `key={node.id}` remounts the editor on node
          switch so segments seed exactly once per agent. While editing one
          agent the IR is never pulled back into the editor (ADR-0029
          / [PHASE-2-DESIGN.md](../../../docs/PHASE-2-DESIGN.md) trap 1).
        */}
        <VariableEditor
          key={node.id}
          segments={node.config.instruction.segments}
          apiRef={editorApiRef}
          onChange={(segments) =>
            updateNodeConfig(node.id, { instruction: { segments } })
          }
        />
        <VariablePalette
          agent={node}
          onInsert={(ref) => {
            // 1. Insert the chip at the captured caret (or end). The
            //    editor's OnChangePlugin fires synchronously and
            //    dispatches `updateNodeConfig({instruction})` with the
            //    new segments.
            editorApiRef.current?.insertVariable(ref);
            // 2. Auto-wire `inputSchemaRef` — the slice's ONLY auto-
            //    mutation beyond the segment append (PHASE-2-DESIGN
            //    decision 4). Skipped when already equal so the
            //    inspector dropdown doesn't see a no-op change event.
            if (node.config.inputSchemaRef !== ref.schema) {
              updateNodeConfig(node.id, { inputSchemaRef: ref.schema });
            }
          }}
          onInsertState={(ref) => {
            // Non-adjacent session-state chip (ADR-0051): insert with
            // `via: "state"`. The OnChangePlugin dispatches the new segments;
            // unlike the positional path, `inputSchemaRef` is NOT touched —
            // state variables are exempt from the single-schema rail.
            editorApiRef.current?.insertVariable(ref, "state");
          }}
        />
      </div>
      </FormSection>
    </div>
  );
}

function FunctionForm({ node }: { node: FunctionNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => selectActiveGraph(s).schemas).map((x) => x.name);
  return (
    <div>
      <Header node={node} />
      <FormSection title="Configuration">
      <div className="field">
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
      <div className="field">
        <label htmlFor="fn-input">inputType</label>
        <TypeRefSelect
          id="fn-input"
          value={node.config.inputType}
          schemas={schemas}
          onChange={(v) => updateNodeConfig(node.id, { inputType: v ?? "str" })}
        />
      </div>
      <div className="field">
        <label htmlFor="fn-output">outputType</label>
        <TypeRefSelect
          id="fn-output"
          value={node.config.outputType}
          schemas={schemas}
          onChange={(v) => updateNodeConfig(node.id, { outputType: v ?? "str" })}
        />
      </div>
      <div className="field">
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
      <div className="field">
        <label htmlFor="fn-body">body</label>
        <div className="field__hint">empty ⇒ null (codegen emits a TODO stub)</div>
        <TextArea
          id="fn-body"
          value={node.config.body}
          onChange={(v) => updateNodeConfig(node.id, { body: v })}
        />
      </div>
      </FormSection>
    </div>
  );
}

function ToolForm({ node }: { node: ToolNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => selectActiveGraph(s).schemas).map((x) => x.name);
  return (
    <div>
      <Header node={node} />
      <FormSection title="Configuration">
      <div className="field">
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
      <div className="field">
        <label htmlFor="tool-input">inputType</label>
        <TypeRefSelect
          id="tool-input"
          value={node.config.inputType}
          schemas={schemas}
          onChange={(v) => updateNodeConfig(node.id, { inputType: v ?? "str" })}
        />
      </div>
      <div className="field">
        <label htmlFor="tool-output">outputType</label>
        <TypeRefSelect
          id="tool-output"
          value={node.config.outputType}
          schemas={schemas}
          onChange={(v) => updateNodeConfig(node.id, { outputType: v ?? "str" })}
        />
      </div>
      <div className="field">
        <label htmlFor="tool-body">body</label>
        <div className="field__hint">empty ⇒ null (codegen emits a TODO stub)</div>
        <TextArea
          id="tool-body"
          value={node.config.body}
          onChange={(v) => updateNodeConfig(node.id, { body: v })}
        />
      </div>
      </FormSection>
    </div>
  );
}

function RouterForm({ node }: { node: RouterNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => selectActiveGraph(s).schemas).map((x) => x.name);
  return (
    <div>
      <Header node={node} />
      <FormSection title="Configuration">
      <div className="field">
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
      <div className="field">
        <label>routes</label>
        <div className="field__hint">
          must match an out-edge `route` label (validator invariant 7)
        </div>
        <StringListEditor
          value={node.config.routes}
          placeholder="ROUTE_NAME"
          onChange={(next) => updateNodeConfig(node.id, { routes: next })}
        />
      </div>
      <div className="field">
        <label htmlFor="router-input">inputType</label>
        <TypeRefSelect
          id="router-input"
          value={node.config.inputType}
          schemas={schemas}
          allowUnset
          onChange={(v) => updateNodeConfig(node.id, { inputType: v })}
        />
      </div>
      <div className="field">
        <label htmlFor="router-body">body</label>
        <div className="field__hint">empty ⇒ null (codegen emits a TODO stub)</div>
        <TextArea
          id="router-body"
          value={node.config.body}
          onChange={(v) => updateNodeConfig(node.id, { body: v })}
        />
      </div>
      </FormSection>
    </div>
  );
}

function JoinForm({ node }: { node: JoinNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  return (
    <div>
      <Header node={node} />
      <FormSection title="Configuration">
      <div className="field">
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
      </FormSection>
    </div>
  );
}

function HumanInputForm({ node }: { node: HumanInputNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => selectActiveGraph(s).schemas).map((x) => x.name);
  return (
    <div>
      <Header node={node} />
      <FormSection title="Configuration">
      <div className="field">
        <label htmlFor="hi-message">message</label>
        <input
          id="hi-message"
          type="text"
          value={node.config.message}
          onChange={(e) => updateNodeConfig(node.id, { message: e.target.value })}
        />
      </div>
      <div className="field">
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
      <div className="field">
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
      </FormSection>
    </div>
  );
}

function WorkflowForm({ node }: { node: WorkflowNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const enterSubgraph = useIRStore((s) => s.enterSubgraph);
  const sub: GraphIR | undefined = node.config.graph;
  const nodeCount = Array.isArray(sub?.nodes) ? sub.nodes.length : 0;
  return (
    <div>
      <Header node={node} />
      <FormSection title="Configuration">
      <div className="field">
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
      <div className="field">
        <label>graph</label>
        {/* Discoverable alternative to double-clicking the canvas card
            (ADR-0050). The selected node is in the active graph by
            definition, so enterSubgraph always resolves. */}
        <button
          type="button"
          className="open-subgraph"
          onClick={() => enterSubgraph(node.id)}
        >
          Open sub-graph ({nodeCount} node{nodeCount === 1 ? "" : "s"})
        </button>
        <div className="field__hint">
          Edits the nested workflow on the canvas — double-clicking the node
          card does the same. Use the breadcrumb above the canvas to come
          back.
        </div>
      </div>
      </FormSection>
    </div>
  );
}

/**
 * LoopForm — `loop` node (ADR-0039 / ADR-0040). Three sub-agents
 * (generator/critic/reviser) are NOT graph nodes — they're rendered as
 * inline blocks here and codegenned into the `<name>_orchestrator` body.
 * Sub-agent instructions are plain text in v1 (no Lexical chip editor):
 * variable wiring is implicit via `inputType`/`payloadType` + the
 * canonical wrapper schemas the codegen emits.
 *
 * Nested edits re-supply the full sub-agent object since
 * `updateNodeConfig` is a shallow config merge.
 */
function LoopForm({ node }: { node: LoopNode }) {
  const updateNodeConfig = useIRStore((s) => s.updateNodeConfig);
  const schemas = useIRStore((s) => selectActiveGraph(s).schemas).map((x) => x.name);
  const cfg = node.config;

  const subAgentRow = (
    key: "generator" | "critic" | "reviser",
    label: string,
  ) => {
    const sub: LoopSubAgent = cfg[key];
    return (
      <FormSection title={label} key={key}>
        <div className="field">
          <label htmlFor={`loop-${key}-model`} className="field__hint">model</label>
          <input
            id={`loop-${key}-model`}
            type="text"
            value={sub.model}
            onChange={(e) =>
              updateNodeConfig(node.id, {
                [key]: { ...sub, model: e.target.value },
              })
            }
          />
        </div>
        <div className="field">
          <label htmlFor={`loop-${key}-instruction`} className="field__hint">instruction</label>
          <textarea
            id={`loop-${key}-instruction`}
            rows={4}
            value={sub.instruction}
            onChange={(e) =>
              updateNodeConfig(node.id, {
                [key]: { ...sub, instruction: e.target.value },
              })
            }
          />
        </div>
      </FormSection>
    );
  };

  return (
    <div>
      <Header node={node} />
      <FormSection title="Loop">
      <div className="field">
        <label htmlFor="loop-max">maxIterations</label>
        <NumberOrEmpty
          id="loop-max"
          value={cfg.maxIterations}
          step="1"
          onChange={(v) =>
            updateNodeConfig(node.id, { maxIterations: v === undefined ? 1 : v })
          }
        />
        <div className="field__hint">must be ≥ 1</div>
      </div>
      <div className="field">
        <label htmlFor="loop-approval">approvalPhrase</label>
        <input
          id="loop-approval"
          type="text"
          value={cfg.approvalPhrase}
          onChange={(e) =>
            updateNodeConfig(node.id, { approvalPhrase: e.target.value })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="loop-input-type">inputType</label>
        <TypeRefSelect
          id="loop-input-type"
          value={cfg.inputType}
          schemas={schemas}
          allowStr
          onChange={(v) => updateNodeConfig(node.id, { inputType: v ?? "str" })}
        />
      </div>
      <div className="field">
        <label htmlFor="loop-payload-type">payloadType</label>
        <TypeRefSelect
          id="loop-payload-type"
          value={cfg.payloadType}
          schemas={schemas}
          allowStr
          onChange={(v) => updateNodeConfig(node.id, { payloadType: v ?? "str" })}
        />
      </div>
      </FormSection>
      {subAgentRow("generator", "generator")}
      {subAgentRow("critic", "critic")}
      {subAgentRow("reviser", "reviser")}
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
    selectActiveGraph(s).nodes.find((n) => n.id === selectedEdge.from),
  );
  const targetNode = useIRStore((s) =>
    selectActiveGraph(s).nodes.find((n) => n.id === selectedEdge.to),
  );
  const setEdgeRoute = useIRStore((s) => s.setEdgeRoute);

  const sourceLabel = sourceNode?.name ?? selectedEdge.from;
  const targetLabel = targetNode?.name ?? selectedEdge.to;
  const isRouterSource = sourceNode?.type === "router";

  return (
    <div>
      <div className="field">
        <div className="field__title">
          {sourceLabel} → {targetLabel}
        </div>
        <div className="field__hint">
          edge · {isRouterSource ? "router branch" : "plain edge"}
        </div>
      </div>

      {isRouterSource ? (
        <div className="field">
          <label htmlFor="edge-route">route</label>
          <div className="field__hint">
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
        <div className="field">
          <div className="field__hint">
            Only router out-edges carry a route label. Delete + reconnect
            to change the endpoint.
          </div>
        </div>
      )}
    </div>
  );
}

// ----- dispatch -----------------------------------------------------------

function formFor(node: NonNullable<ReturnType<typeof pickNode>>): ReactNode {
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
    case "loop":
      return <LoopForm node={node} />;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return <div className="empty">Unknown node type.</div>;
    }
  }
}

function pickNode(s: {
  selectedNodeId: string | null;
  ir: GraphIR;
  subgraphPath: string[];
}) {
  // Selection is scoped to the active graph (ADR-0050): the same id could
  // legally recur in a nested sub-graph of a hand-loaded IR.
  return s.selectedNodeId
    ? selectActiveGraph(s).nodes.find((n) => n.id === s.selectedNodeId) ?? null
    : null;
}

export function Inspector() {
  const selectedEdge = useIRStore((s) => s.selectedEdge);
  const node = useIRStore(pickNode);

  // `mode="wait"` guarantees the outgoing form (and its Lexical editor)
  // fully unmounts before the next one mounts — preserving the
  // seed-once-per-node invariant (ADR-0029). Exits stay <= 120ms.
  const key = selectedEdge
    ? `edge:${selectedEdge.from}|${selectedEdge.to}|${selectedEdge.route ?? ""}`
    : node?.id ?? "empty";

  const content: ReactNode = selectedEdge ? (
    <EdgeForm />
  ) : node ? (
    formFor(node)
  ) : (
    <div className="empty">Select a node or edge to edit it.</div>
  );

  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={key}
        variants={formSwap}
        initial="hidden"
        animate="show"
        exit="exit"
      >
        {content}
      </m.div>
    </AnimatePresence>
  );
}
