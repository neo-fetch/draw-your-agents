/**
 * Pure reducer for "add a new node of type T to the IR" (ADR-0025).
 *
 * The hard problem this module solves is **id + name minting** against the
 * flat global namespace that spans the parent IR plus every nested
 * `workflow.config.graph` sub-IR (ADR-0017, validator invariant 1). The
 * generator is the foundation the connect-edges slice and the Phase 2 chip
 * system will both build on, so it lives here — React-free, zustand-free,
 * DOM-free — and is exercised under `node --test` from a cold checkout
 * (ADR-0022 reducer-purity rule).
 *
 * A freshly added node has no edges, so the result IR is intentionally left
 * with exactly one validation error — `UNREACHABLE_NODE` on the new node.
 * Wiring it up belongs to the next slice. The Preview pane already surfaces
 * findings without crashing (ADR-0022); we do not suppress this.
 */
import type {
  AgentNode,
  FunctionNode,
  GraphIR,
  GraphNode,
  HumanInputNode,
  JoinNode,
  LoopNode,
  NodeType,
  RouterNode,
  ToolNode,
  UiPosition,
  WorkflowNode,
} from "@graphical-agents/ir";
import { graphAtPath, updateGraphAtPath } from "./subgraph.ts";

export type AddableNodeType = NodeType;

const ID_PREFIX: Record<NodeType, string> = {
  agent: "n_agent",
  function: "n_function",
  router: "n_router",
  tool: "n_tool",
  join: "n_join",
  humanInput: "n_human_input",
  workflow: "n_workflow",
  loop: "n_loop",
};

const NAME_PREFIX: Record<NodeType, string> = {
  agent: "agent",
  function: "function",
  router: "router",
  tool: "tool",
  join: "join",
  humanInput: "human_input",
  workflow: "workflow",
  loop: "loop",
};

/**
 * Collect every node `id` in the IR, recursing into `workflow.config.graph`.
 * Matches the recursion shape of the validator's nested traversal (ADR-0017).
 * Note: node ids are NOT formally shared across sub-graphs by the validator
 * (DUPLICATE_NODE_ID is per-graph), but we mint globally-unique ids anyway —
 * a single flat id space simplifies cross-graph lookups in the upcoming
 * connect-edges slice.
 */
export function collectAllIds(ir: GraphIR, out: Set<string> = new Set()): Set<string> {
  for (const n of ir.nodes) {
    out.add(n.id);
    if (n.type === "workflow") collectAllIds(n.config.graph, out);
  }
  return out;
}

/**
 * Collect every node `name` in the IR, recursing into `workflow.config.graph`.
 * Node names ARE shared in one flat global namespace across parent + every
 * nested sub-graph (ADR-0017, validator invariant 1).
 */
export function collectAllNames(ir: GraphIR, out: Set<string> = new Set()): Set<string> {
  for (const n of ir.nodes) {
    out.add(n.name);
    if (n.type === "workflow") collectAllNames(n.config.graph, out);
  }
  return out;
}

function nextFree(prefix: string, taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `${prefix}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Mint a fresh id for `type` against the IR's global id space. */
export function makeNodeId(ir: GraphIR, type: AddableNodeType): string {
  return nextFree(ID_PREFIX[type], collectAllIds(ir));
}

/** Mint a fresh, valid Python-identifier name for `type` against the IR's flat global name space. */
export function makeNodeName(ir: GraphIR, type: AddableNodeType): string {
  return nextFree(NAME_PREFIX[type], collectAllNames(ir));
}

/**
 * Default `ui` for a fresh node — staggered to the right of the existing
 * graph by the same 260px gap every fixture uses, so it doesn't stack on
 * top of an existing node. Full free-positioning ships when canvas drag
 * is wired up.
 */
export function defaultPositionFor(ir: GraphIR): UiPosition {
  if (ir.nodes.length === 0) return { x: 0, y: 0 };
  let maxX = -Infinity;
  let yAtMaxX = 0;
  for (const n of ir.nodes) {
    const x = n.ui?.x ?? 0;
    if (x > maxX) {
      maxX = x;
      yAtMaxX = n.ui?.y ?? 0;
    }
  }
  return { x: (maxX === -Infinity ? 0 : maxX) + 280, y: yAtMaxX };
}

/**
 * Build a minimal valid sub-IR for a fresh `workflow` node:
 * one inner `function` node + a `START → inner` edge.
 *
 * An empty sub-IR fails `NO_START_EDGE` and would surface nested findings
 * instead of the single `UNREACHABLE_NODE` the test oracle pins. So a
 * one-node passthrough is the default; the inner node's name is minted
 * against `parent ∪ {workflow's own name}` so the flat global namespace
 * stays unique (ADR-0017).
 */
function minimalSubIR(
  parentIR: GraphIR,
  workflowNodeName: string,
  workflowNodeId: string,
): GraphIR {
  const reservedIds = collectAllIds(parentIR);
  reservedIds.add(workflowNodeId);
  const reservedNames = collectAllNames(parentIR);
  reservedNames.add(workflowNodeName);

  const innerId = nextFree(ID_PREFIX.function, reservedIds);
  const innerName = nextFree(NAME_PREFIX.function, reservedNames);

  const inner: FunctionNode = {
    id: innerId,
    type: "function",
    name: innerName,
    ui: { x: 0, y: 0 },
    config: {
      description: "",
      inputType: "str",
      outputType: "str",
      emits: "output",
      body: null,
    },
  };
  return {
    irVersion: parentIR.irVersion,
    name: workflowNodeName,
    schemas: [],
    nodes: [inner],
    edges: [{ from: "START", to: innerId }],
  };
}

/**
 * Build a default node of `type`. Each branch returns a config that
 * satisfies its TypeScript shape AND every per-type validator rule in
 * `packages/ir/src/validate.ts`, so the only error on a fresh add is
 * `UNREACHABLE_NODE` on the new node.
 *
 * Decisions (recorded in ADR-0025):
 *  - `router.routes: ["DEFAULT"]` — ROUTER_NO_ROUTES requires ≥1 route.
 *  - `humanInput.message: "Enter input:"` — HUMANINPUT_MISSING_MESSAGE
 *    requires a non-empty message.
 *  - `workflow.graph` — one-node passthrough (see `minimalSubIR`).
 *  - `agent.model: "gemini-flash-latest"` — matches the existing
 *    fixture default; AGENT_MISSING_MODEL requires a non-empty model.
 */
function makeDefaultNode(
  parentIR: GraphIR,
  type: AddableNodeType,
  id: string,
  name: string,
  ui: UiPosition,
): GraphNode {
  switch (type) {
    case "agent": {
      const node: AgentNode = {
        id, type, name, ui,
        config: {
          model: "gemini-flash-latest",
          instruction: { segments: [] },
          mode: "task",
          outputSchemaRef: "str",
          inputSchemaRef: null,
        },
      };
      return node;
    }
    case "function": {
      const node: FunctionNode = {
        id, type, name, ui,
        config: {
          description: "",
          inputType: "str",
          outputType: "str",
          emits: "output",
          body: null,
        },
      };
      return node;
    }
    case "router": {
      const node: RouterNode = {
        id, type, name, ui,
        config: {
          description: "",
          routes: ["DEFAULT"],
          inputType: "str",
          body: null,
        },
      };
      return node;
    }
    case "tool": {
      const node: ToolNode = {
        id, type, name, ui,
        config: {
          description: "",
          inputType: "str",
          outputType: "str",
          body: null,
        },
      };
      return node;
    }
    case "join": {
      const node: JoinNode = { id, type, name, ui, config: { description: "" } };
      return node;
    }
    case "humanInput": {
      const node: HumanInputNode = {
        id, type, name, ui,
        config: {
          message: "Enter input:",
          payloadRef: null,
          responseSchemaRef: null,
        },
      };
      return node;
    }
    case "workflow": {
      const node: WorkflowNode = {
        id, type, name, ui,
        config: {
          description: "",
          graph: minimalSubIR(parentIR, name, id),
        },
      };
      return node;
    }
    case "loop": {
      const node: LoopNode = {
        id, type, name, ui,
        config: {
          maxIterations: 5,
          approvalPhrase: "APPROVED",
          inputType: "str",
          payloadType: "str",
          generator: { model: "gemini-flash-latest", instruction: "" },
          critic: { model: "gemini-flash-latest", instruction: "" },
          reviser: { model: "gemini-flash-latest", instruction: "" },
        },
      };
      return node;
    }
  }
}

/**
 * Add a new node of `type` to the graph at `path` inside `root` (ADR-0050).
 * Id and name are minted against the **root** — the flat global namespace
 * spans every nesting level (ADR-0017) — but the staggered default position
 * is computed against the **target graph**, so the node lands in the canvas
 * the user is looking at. `root` is also what `minimalSubIR` reserves names
 * against when adding a workflow-inside-a-workflow.
 *
 * No-op (same `ir` reference, empty `nodeId`) when `path` doesn't resolve.
 * Pure: `root` is untouched.
 */
export function addNodeAt(
  root: GraphIR,
  path: readonly string[],
  type: AddableNodeType,
  position?: UiPosition,
): { ir: GraphIR; nodeId: string } {
  const target = graphAtPath(root, path);
  if (!target) return { ir: root, nodeId: "" };
  const id = makeNodeId(root, type);
  const name = makeNodeName(root, type);
  // Explicit position (drag-and-drop drop point, ADR-0034) wins; otherwise
  // fall back to the staggered default used by click-to-add.
  const ui = position ?? defaultPositionFor(target);
  const node = makeDefaultNode(root, type, id, name, ui);
  return {
    ir: updateGraphAtPath(root, path, (g) => ({
      ...g,
      nodes: [...g.nodes, node],
    })),
    nodeId: id,
  };
}

/**
 * Add a new node of `type` to `ir` (top level). Returns a new IR and the
 * minted node id so the store can select it without re-deriving. Pure:
 * `ir` is untouched.
 */
export function addNode(
  ir: GraphIR,
  type: AddableNodeType,
  position?: UiPosition,
): { ir: GraphIR; nodeId: string } {
  return addNodeAt(ir, [], type, position);
}
