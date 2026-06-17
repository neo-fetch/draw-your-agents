/**
 * VariablePalette — insert-a-chip control for the selected agent (ADR-0030).
 *
 * A thin React shell over the pure `candidateVariables` helper in
 * [insertVariable.ts](../store/insertVariable.ts). The palette is read-only
 * over the IR: clicking a candidate calls `onInsert(ref)` (which drives
 * the editor's `VariableEditorAPI.insertVariable`) and the parent dispatches
 * the `inputSchemaRef` auto-wire patch in the same handler.
 *
 * Per [PHASE-2-DESIGN.md](../../../../docs/PHASE-2-DESIGN.md) decision 7,
 * the not-upstream advisory is a UI hint only — the validator does not gain
 * a new code (would touch frozen `packages/*`).
 */
import type { CSSProperties } from "react";
import type { AgentNode } from "@graphical-agents/ir";
import { useIRStore } from "../store/irStore.ts";
import { selectActiveGraph } from "../store/subgraph.ts";
import {
  candidateVariables,
  chipSchemas,
  stateCandidateVariables,
  type VariableCandidate,
  type VariableRef,
} from "../store/insertVariable.ts";

const BUTTON: CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  margin: "2px 4px 2px 0",
  border: "1px solid #c4c8d0",
  borderRadius: 4,
  background: "#f6f7f9",
  cursor: "pointer",
};

const BUTTON_NOT_UPSTREAM: CSSProperties = {
  ...BUTTON,
  borderColor: "#d8a200",
  background: "#fffaeb",
};

// Non-adjacent (session-state) chips read a distinct colour (ADR-0051).
const BUTTON_STATE: CSSProperties = {
  ...BUTTON,
  borderColor: "#5b8def",
  background: "#eef3ff",
};

const HINT: CSSProperties = { fontSize: 11, color: "#777" };

function groupBySource(
  candidates: VariableCandidate[],
): Map<string, VariableCandidate[]> {
  const groups = new Map<string, VariableCandidate[]>();
  for (const c of candidates) {
    const list = groups.get(c.source) ?? [];
    list.push(c);
    groups.set(c.source, list);
  }
  return groups;
}

export interface VariablePaletteProps {
  agent: AgentNode;
  onInsert: (ref: VariableRef) => void;
  /** Insert a non-adjacent session-state chip (ADR-0051). */
  onInsertState: (ref: VariableRef) => void;
}

export function VariablePalette({ agent, onInsert, onInsertState }: VariablePaletteProps) {
  // Candidates come from the *active* graph (ADR-0050): the validator
  // resolves var-segment sources strictly per-level, so only producers in
  // the agent's own graph are legal.
  const ir = useIRStore(selectActiveGraph);
  const candidates = candidateVariables(ir, agent.id);
  const locked = chipSchemas(agent);
  const lockedSchema = locked.size === 1 ? [...locked][0] : undefined;
  const groups = groupBySource(candidates);
  const anyNotUpstream = candidates.some((c) => !c.isUpstream);

  // Non-adjacent state candidates: any ancestor's structured fields, no rail.
  const stateCandidates = stateCandidateVariables(ir, agent.id);
  const stateGroups = new Map<string, VariableRef[]>();
  for (const c of stateCandidates) {
    const list = stateGroups.get(c.source) ?? [];
    list.push(c);
    stateGroups.set(c.source, list);
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={HINT}>
        insert a variable —
        {lockedSchema
          ? ` locked to ${lockedSchema} (single-schema rail)`
          : ` pick a producer field; inputSchemaRef auto-sets on insert`}
      </div>
      {candidates.length === 0 ? (
        <div style={{ ...HINT, fontStyle: "italic", marginTop: 4 }}>
          {lockedSchema
            ? `no producer in this graph outputs ${lockedSchema}`
            : "no upstream node outputs a structured schema"}
        </div>
      ) : (
        [...groups.entries()].map(([source, items]) => (
          <div
            key={source}
            // mouseDown-down-prevent on the container would block focus
            // leaving the editor; we rely instead on the captured-
            // selection snapshot in `VariableEditor` (cheaper, no focus
            // gymnastics).
            style={{ marginTop: 4 }}
          >
            <span style={HINT}>
              {source}.{items[0]!.schema} —{" "}
            </span>
            {items.map((c) => (
              <button
                key={`${c.source}::${c.field}`}
                type="button"
                style={c.isUpstream ? BUTTON : BUTTON_NOT_UPSTREAM}
                title={
                  c.isUpstream
                    ? `Insert <${c.schema}.${c.field} from ${c.source}>`
                    : `Warning: ${c.source} is not upstream of ${agent.name}; the value won't flow at runtime.`
                }
                onClick={() =>
                  onInsert({
                    source: c.source,
                    schema: c.schema,
                    field: c.field,
                  })
                }
              >
                {c.field}
                {c.isUpstream ? "" : " ⚠"}
              </button>
            ))}
          </div>
        ))
      )}
      {anyNotUpstream ? (
        <div style={{ ...HINT, marginTop: 4 }}>
          ⚠ marked fields come from nodes that aren't upstream of{" "}
          {agent.name}. Insertion still works; data won't flow at runtime
          until you wire the edge (advisory only — invariant 6 stays clean).
        </div>
      ) : null}

      {stateCandidates.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <div style={HINT}>
            from session state — any upstream node's field, no single-schema rail
          </div>
          {[...stateGroups.entries()].map(([source, items]) => (
            <div key={`state::${source}`} style={{ marginTop: 4 }}>
              <span style={HINT}>
                {source}.{items[0]!.schema} —{" "}
              </span>
              {items.map((c) => (
                <button
                  key={`state::${c.source}::${c.field}`}
                  type="button"
                  style={BUTTON_STATE}
                  title={`Insert {${c.schema}.${c.field}} (from session state, source ${c.source})`}
                  onClick={() =>
                    onInsertState({
                      source: c.source,
                      schema: c.schema,
                      field: c.field,
                    })
                  }
                >
                  {c.field}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
