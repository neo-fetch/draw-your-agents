/**
 * Pure reducer for "insert a variable chip into an agent's prompt" (ADR-0030).
 *
 * The single semantic for variable insertion at the IR layer: append a
 * `VarSegment` to the agent's `instruction.segments` AND set
 * `agent.config.inputSchemaRef = ref.schema` when not already equal. The
 * auto-wire of `inputSchemaRef` is the **only** auto-mutation in 2b
 * (PHASE-2-DESIGN decision 4) — no edge creation, no chip rewriting, no
 * schema authoring.
 *
 * Joins the install-free reducer family alongside `irReducer.ts`,
 * `addNode.ts`, `irEdges.ts`. React-free, zustand-free, no `lexical` import —
 * exercised under `node --test` from a cold checkout (ADR-0011 / ADR-0013 /
 * ADR-0022).
 *
 * Also exports the palette's pure candidate logic:
 * `candidateVariables` (with the single-schema rail applied) and
 * `upstreamProducers` (drives the UI advisory). The validator owns invariant
 * 6; this module narrows what the palette *offers* but never re-implements
 * validation.
 */
import type {
  AgentNode,
  GraphIR,
  GraphNode,
  InstructionSegment,
  VarSegment,
} from "@graphical-agents/ir";

export interface VariableRef {
  schema: string;
  field: string;
  source: string;
}

/**
 * Append a `VarSegment` to the named agent's instruction AND set
 * `inputSchemaRef = ref.schema` (only when not already equal). Returns a new
 * IR; original untouched. Sibling node identity preserved so React Flow
 * doesn't re-render unaffected nodes.
 *
 * No-op (returns the input IR ref) when `agentId` is unknown or doesn't name
 * an agent — keeps the store dispatch safe across selection races.
 */
export function insertVariable(
  ir: GraphIR,
  agentId: string,
  ref: VariableRef,
): GraphIR {
  const target = ir.nodes.find((n) => n.id === agentId);
  if (!target || target.type !== "agent") return ir;

  const varSeg: VarSegment = {
    type: "var",
    schema: ref.schema,
    field: ref.field,
    source: ref.source,
  };
  const nextSegments: InstructionSegment[] = [
    ...target.config.instruction.segments,
    varSeg,
  ];
  const inputSchemaUnchanged = target.config.inputSchemaRef === ref.schema;

  const nodes = ir.nodes.map((n): GraphNode => {
    if (n.id !== agentId) return n;
    const a = n as AgentNode;
    const nextConfig = {
      ...a.config,
      instruction: { segments: nextSegments },
      ...(inputSchemaUnchanged ? {} : { inputSchemaRef: ref.schema }),
    };
    return { ...a, config: nextConfig };
  });
  return { ...ir, nodes };
}

// ---- palette candidate computation --------------------------------------

/**
 * Mirrors the validator's `producerOutput` helper in
 * [packages/ir/src/validate.ts](../../../../packages/ir/src/validate.ts) for
 * the producer types the palette cares about. Returns the node's output type
 * reference (a schema name, `"str"`, or `null`/`undefined`).
 */
function producerOutput(node: GraphNode): string | null | undefined {
  switch (node.type) {
    case "function":
    case "tool":
      return node.config.outputType;
    case "agent":
      return node.config.outputSchemaRef;
    case "humanInput":
      return node.config.responseSchemaRef ?? null;
    default:
      return undefined;
  }
}

function isStructuredSchema(
  ir: GraphIR,
  ref: string | null | undefined,
): ref is string {
  if (ref === null || ref === undefined) return false;
  if (ref === "str") return false;
  return ir.schemas.some((s) => s.name === ref);
}

/**
 * Set of schemas referenced by the agent's *existing* var chips. Drives the
 * single-schema rail (PHASE-2-DESIGN decision 5) — keyed off chips, not
 * `inputSchemaRef`, by deliberate design.
 */
export function chipSchemas(agent: AgentNode): Set<string> {
  const out = new Set<string>();
  for (const seg of agent.config.instruction.segments) {
    if (seg.type === "var") out.add(seg.schema);
  }
  return out;
}

/**
 * Reverse-BFS upstream of `agentId`, returning the set of node *names* that
 * can transitively reach the agent through `ir.edges`. Used by the UI
 * advisory: a chip whose `source` is not in this set won't see data flow at
 * runtime (positional dataflow). Deliberately not a validator code — the
 * gap is flagged in the UI per PHASE-2-DESIGN decision 7.
 */
export function upstreamProducers(ir: GraphIR, agentId: string): Set<string> {
  const target = ir.nodes.find((n) => n.id === agentId);
  if (!target) return new Set();
  const idByName = new Map<string, string>();
  const nameById = new Map<string, string>();
  for (const n of ir.nodes) {
    idByName.set(n.name, n.id);
    nameById.set(n.id, n.name);
  }
  // edges are id-based on `to`; `from` may be "START" or a node id.
  const incoming = new Map<string, string[]>();
  for (const e of ir.edges) {
    if (e.from === "START") continue;
    const list = incoming.get(e.to) ?? [];
    list.push(e.from);
    incoming.set(e.to, list);
  }
  const visitedIds = new Set<string>();
  const stack: string[] = [agentId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const prev of incoming.get(cur) ?? []) {
      if (visitedIds.has(prev)) continue;
      visitedIds.add(prev);
      stack.push(prev);
    }
  }
  const out = new Set<string>();
  for (const id of visitedIds) {
    const name = nameById.get(id);
    if (name) out.add(name);
  }
  return out;
}

export interface VariableCandidate extends VariableRef {
  /** True when `source` is in the agent's upstream — drives the UI advisory. */
  isUpstream: boolean;
}

/**
 * Candidate `{source, schema, field}` triples the palette should offer for
 * `agentId`. Filters:
 *  - excludes the agent itself
 *  - includes only producers whose output is a declared structured schema
 *  - applies the single-schema rail: if the agent already has any var chip
 *    (schema A), only schema-A producers are offered
 *
 * Returns one candidate per `(source, field)` pair. Each carries an
 * `isUpstream` flag computed from `ir.edges` — the UI surfaces an advisory
 * (text only) when false. The validator does not gain a new code.
 */
export function candidateVariables(
  ir: GraphIR,
  agentId: string,
): VariableCandidate[] {
  const agent = ir.nodes.find((n) => n.id === agentId);
  if (!agent || agent.type !== "agent") return [];

  const lockedSchemas = chipSchemas(agent);
  const upstream = upstreamProducers(ir, agentId);
  const schemaIndex = new Map<string, readonly string[]>();
  for (const s of ir.schemas) {
    schemaIndex.set(
      s.name,
      s.fields.map((f) => f.name),
    );
  }

  const out: VariableCandidate[] = [];
  for (const n of ir.nodes) {
    if (n.id === agentId) continue;
    const ref = producerOutput(n);
    if (!isStructuredSchema(ir, ref)) continue;
    const schema = ref;
    if (lockedSchemas.size > 0 && !lockedSchemas.has(schema)) continue;
    const fields = schemaIndex.get(schema) ?? [];
    for (const field of fields) {
      out.push({
        source: n.name,
        schema,
        field,
        isUpstream: upstream.has(n.name),
      });
    }
  }
  return out;
}
