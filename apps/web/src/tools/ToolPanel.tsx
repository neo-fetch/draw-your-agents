/**
 * ToolPanel — graphical CRUD over the root tool library `ir.tools` (ADR-0059).
 *
 * Thin React shell over the pure reducers in `store/tools.ts`, styled with the
 * schema panel's card vocabulary (ADR-0035). A library tool is an
 * agent-callable function, not a graph node: it has no canvas card and no
 * edges. Agents and a loop's generator / critic / reviser opt into it with the
 * tool picker in their node popover.
 *
 * The library is root-only, so this panel shows the same list at every
 * sub-graph depth (contrast SchemaPanel, which is per-level). Validator
 * findings (bad names, clashes, unknown types) surface in Preview as usual.
 */
import type { SchemaDef, ToolDef, ToolParam } from "@graphical-agents/ir";
import { useIRStore } from "../store/irStore.ts";
import { scalarTypes } from "../store/schemas.ts";
import { toolSignature } from "../store/tools.ts";
import { NameInput } from "../schemas/SchemaPanel.tsx";
import { BodyEditor } from "../inspector/BodyEditor.tsx";

/** Stable empty list so the store selector never returns a fresh `[]`. */
const NO_TOOLS: readonly ToolDef[] = [];

function TypeSelect({
  ariaLabel,
  value,
  schemas,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  schemas: readonly SchemaDef[];
  onChange: (next: string) => void;
}) {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <optgroup label="scalar">
        {scalarTypes().map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </optgroup>
      {schemas.length > 0 && (
        <optgroup label="schema">
          {schemas.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function ParamRow({ tool, param }: { tool: ToolDef; param: ToolParam }) {
  const schemas = useIRStore((s) => s.ir.schemas);
  const updateToolParam = useIRStore((s) => s.updateToolParam);
  const deleteToolParam = useIRStore((s) => s.deleteToolParam);
  return (
    <div className="schema-field-row tool-param-row">
      <NameInput
        initial={param.name}
        ariaLabel={`param name ${tool.name}.${param.name}`}
        onCommit={(next) => updateToolParam(tool.name, param.name, { name: next })}
      />
      <TypeSelect
        ariaLabel={`param type ${tool.name}.${param.name}`}
        value={param.type}
        schemas={schemas}
        onChange={(type) => updateToolParam(tool.name, param.name, { type })}
      />
      <button
        type="button"
        aria-label={`delete param ${tool.name}.${param.name}`}
        title="remove param"
        onClick={() => deleteToolParam(tool.name, param.name)}
        className="schema-x"
      >
        ✕
      </button>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolDef }) {
  const schemas = useIRStore((s) => s.ir.schemas);
  const renameTool = useIRStore((s) => s.renameTool);
  const deleteTool = useIRStore((s) => s.deleteTool);
  const updateTool = useIRStore((s) => s.updateTool);
  const addToolParam = useIRStore((s) => s.addToolParam);

  return (
    <div className="schema-card tool-card">
      <div className="schema-card__head">
        <NameInput
          initial={tool.name}
          ariaLabel={`tool name ${tool.name}`}
          onCommit={(next) => renameTool(tool.name, next)}
        />
        <button
          type="button"
          aria-label={`delete tool ${tool.name}`}
          title="delete tool (also removes it from every agent that uses it)"
          onClick={() => deleteTool(tool.name)}
          className="schema-x"
        >
          ✕
        </button>
      </div>

      <label className="tool-card__label" htmlFor={`tool-desc-${tool.name}`}>
        description <span className="tool-card__hint">— the LLM reads this</span>
      </label>
      <textarea
        id={`tool-desc-${tool.name}`}
        className="tool-card__desc"
        rows={2}
        value={tool.description}
        onChange={(e) => updateTool(tool.name, { description: e.target.value })}
      />

      <div className="tool-card__label">params</div>
      <div className="schema-card__fields">
        {tool.params.map((p) => (
          <ParamRow key={p.name} tool={tool} param={p} />
        ))}
      </div>
      <button type="button" className="schema-add-field" onClick={() => addToolParam(tool.name)}>
        + param
      </button>

      <div className="tool-card__returns">
        <span className="tool-card__label">returns</span>
        <TypeSelect
          ariaLabel={`return type ${tool.name}`}
          value={tool.returns}
          schemas={schemas}
          onChange={(returns) => updateTool(tool.name, { returns })}
        />
      </div>

      <div className="tool-card__label">body</div>
      {/* Remount on rename / signature change so the editor reseeds. */}
      <BodyEditor
        key={`${tool.name}:${toolSignature(tool)}`}
        value={tool.body}
        signature={toolSignature(tool)}
        returns={`return a ${tool.returns}`}
        onCommit={(body) => updateTool(tool.name, { body })}
      />
    </div>
  );
}

export function ToolPanel() {
  const tools = useIRStore((s) => s.ir.tools) ?? NO_TOOLS;
  const inSubgraph = useIRStore((s) => s.subgraphPath.length > 0);
  const addTool = useIRStore((s) => s.addTool);
  return (
    <div className="schema-panel tool-panel">
      {inSubgraph && (
        <div className="schema-scope">
          tools are shared by <strong>every</strong> level
        </div>
      )}
      <div>
        <button type="button" className="schema-add" onClick={() => addTool()}>
          + Tool
        </button>
      </div>
      {tools.length === 0 ? (
        <div className="schema-empty">
          No tools. Add one, then tick it on an agent — or a loop's critic or
          reviser — so the model can call it while it works.
        </div>
      ) : (
        <div className="schema-list">
          {tools.map((t) => (
            <ToolCard key={t.name} tool={t} />
          ))}
        </div>
      )}
    </div>
  );
}
