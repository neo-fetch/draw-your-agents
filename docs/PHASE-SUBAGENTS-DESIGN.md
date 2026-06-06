# Design — Loop node (critic/reviser) & orchestrator agents (feature #3)

**Status:** architect design note (no code). Implementing session(s) append their own build-record
ADR(s) (next in sequence). Cold-start artifact for the slice prompts.

**Goal:** add a deterministic **critic + reviser loop** ("iterate until approved, max-N") as a
**dedicated `loop` node type** — a first-class node alongside `agent`/`function`/`router`/etc. Its
sub-agents (critic, reviser) are **agent-shaped** (they reuse the agent config), so they respect the
existing agent node model. Grounded in the official docs (sources at bottom): an ADK `Agent` takes
`sub_agents=[...]`, **`LoopAgent(sub_agents=[…], max_iterations=N)`** is the deterministic loop
primitive, and — **confirmed by the user** — a `LoopAgent` is accepted as a node inside
`Workflow(edges=…)` and its internal execution does not conflict with the graph workflow.

**Breaks the "frozen `packages/*`" rule** deliberately (IR + validator + codegen + golden tests +
fidelity). Biggest feature to date.

---

## What exists today (grounding)

- `NodeType` union + per-type configs in [packages/ir/src/types.ts](../packages/ir/src/types.ts).
  `AgentConfig` = `model`, `instruction`, `modelParams?`, **`mode?: "task" | "single_turn"`**,
  `tools?`, `inputSchemaRef?`, `outputSchemaRef`. (Docs: `mode` is *specifically* for sub-agents
  under a coordinator — it finally has a use here.)
- `renderAgent` ([packages/codegen/src/fragments.ts](../packages/codegen/src/fragments.ts)) emits
  `<name> = Agent(name=, model=, instruction=, [params], [input_schema], output_schema)`. **Reusable
  to emit the critic/reviser sub-agents.** The node `name` is the symbol used in `Workflow(edges=…)`.
- `addNode` ([apps/web/src/store/addNode.ts](../apps/web/src/store/addNode.ts)) already mints any
  `NodeType` with a default config; the palette + canvas render every type. Adding `loop` extends
  these the same way the other six types already work.

## Decision: a dedicated `loop` node type (not an agent-config flag)

The user chose a dedicated node type over extending `AgentConfig` (which would leave the agent
node's own `model`/`instruction`/`output` fields dead in loop mode). So:

```ts
// new member of NodeType: "loop"
interface SubAgentConfig extends AgentConfig {}   // critic/reviser ARE agent-shaped (reuse)
interface LoopConfig {
  description?: string;
  maxIterations: number;        // integer ≥ 1
  critic:  SubAgentConfig;      // emits feedback, or the completion phrase when satisfied
  reviser: SubAgentConfig;      // revises, or calls exit_loop on the completion phrase
}
```
v1 fixes the shape to **critic + reviser** (your scope choice). A future general
`subAgents: SubAgentConfig[]` (and a coordinator flavor) slots in later without disturbing this.

## Codegen (the real work)

For a `loop` node `N` with `LoopConfig`:
- emit two sub-agents `N_critic`, `N_reviser` by **reusing `renderAgent`** on the critic/reviser
  configs, then augmenting: `include_contents='none'`, `output_key` set to the **canonical state
  keys** (`criticism`, `current_document`), and the instruction text wrapped with the fixed exit
  convention (critic emits a `COMPLETION_PHRASE` when satisfied; reviser calls `exit_loop` on that
  phrase, else revises).
- emit an `exit_loop(tool_context)` function (in `functions.py`) that sets
  `tool_context.actions.escalate = True; tool_context.actions.skip_summarization = True`, attached
  to the reviser via `tools=[exit_loop]`.
- emit `N = LoopAgent(name="N", sub_agents=[N_critic, N_reviser], max_iterations=<maxIterations>)`.
- imports: `from google.adk.agents import LoopAgent, Agent` (+ `ToolContext` for `exit_loop`).
- **`N` is the symbol placed in `Workflow(edges=…)`** — the LoopAgent is one DAG node; the graph
  stays acyclic, the loop is contained (user-confirmed this composes).

**Data-flow boundary = a known rough edge → "refinable scaffold."** Inside a `LoopAgent`,
critic↔reviser communicate via session state (`output_key`/`{placeholder}`) — the mechanism we
deferred to "Phase 3." v1 hardcodes the canonical keys (`current_document`/`criticism`) from the
official example; mapping the graph's positional `node_input` into the loop's initial state is the
part a user may refine. Squarely the project's "at worst a functioning baseline" promise: we emit a
structurally-correct loop, not a guaranteed end-to-end wire.

## Validator (new codes)

For a `loop` node: `LOOP_MISSING_CRITIC` / `LOOP_MISSING_REVISER` (both required),
`LOOP_BAD_MAX_ITERATIONS` (integer ≥ 1), and the **critic/reviser are validated as agents** (reuse
the agent checks: model present, ref resolution, var-segment provenance). The generated symbols
`N_critic` / `N_reviser` join the **flat global namespace** (ADR-0017) so they can't collide
(`DUPLICATE_NODE_NAME` reused). Standard node checks (reachability, DAG, edge endpoints) treat the
loop node like any other node — it has one input and one output in the graph.

## UI (apps/web)

- **Palette:** a new "Loop" entry (it's a `NodeType` now — palette/drag-drop/minting extend
  automatically once `addNode` has a default `LoopConfig`).
- **Inspector `LoopForm`:** `maxIterations` + a **critic** sub-form and a **reviser** sub-form, each
  reusing the existing agent field widgets (model, instruction editor, etc.) since sub-agents are
  agent-shaped. v1: plain-text instructions for sub-agents (var-chips use the source-bound mechanism,
  not loop state placeholders — out of scope).
- **Canvas:** add `loop` to the node-type color map + a ↻ badge (reuse the `data-node-type` styling
  hook from ADR-0033/0034).

## Verification

- **3-A (fidelity) — already answered by the user** (`LoopAgent` accepted as a `Workflow` node, no
  conflict). Folds into 3-B as a routine ADR-0021 fidelity check on the generated project rather
  than a gating probe.
- **Golden test:** a `critic-loop.ir.json` fixture (one `loop` node) → assert `agents.py` /
  `functions.py` emit `N_critic`, `N_reviser`, `exit_loop`, and
  `N = LoopAgent(sub_agents=[N_critic, N_reviser], max_iterations=…)`; `workflow.py` lists `N`.
- **Validator spec:** missing critic/reviser, bad max_iterations, sub-agent name collision; valid
  loop passes.
- **Fidelity:** the generated project imports + the `LoopAgent` constructs as a `Workflow` node under
  real `google-adk==2.0.0` (user runs it).
- **UI:** build + browser — drag a Loop node, fill maxIterations + critic/reviser, Preview shows the
  `LoopAgent` scaffold, node badge renders, Save/Load round-trips.

## Slice plan

- **Slice 3-B — packages.** New `loop` `NodeType` + `LoopConfig` (types + JSON schema); validator
  codes (reusing agent checks for the sub-agents); codegen (reuse `renderAgent` for sub-agents +
  `exit_loop` emission + `LoopAgent` assembly + place `N` in `Workflow`); `critic-loop` golden
  fixture; fidelity extension (the user-confirmed composition, now pinned by a test). Ends green on
  `npm test`. Appends an ADR.
- **Slice 3-C — web.** `addNode` default `LoopConfig`; palette "Loop" entry; inspector `LoopForm`
  (maxIterations + critic/reviser sub-forms reusing agent widgets); canvas color + ↻ badge;
  Save/Load round-trip; headless test that a dropped loop node `compile()`s to the `LoopAgent`
  scaffold. Appends an ADR.

(3-A is satisfied by the user's confirmation; no standalone probe slice needed.)

## Out of scope (noted)
Coordinator (LLM-delegation `Agent(sub_agents=…)`) flavor; general N-ary `subAgents`; var-chips
inside loop sub-agents; full session-state data-flow UI; `SequentialAgent`/`ParallelAgent`
orchestration; nested orchestrators.

## Sources
- [Collaborative workflows](https://adk.dev/workflows/collaboration/) — `Agent(sub_agents=…)`, the
  `mode` field, "agents with task/single_turn modes can be Workflow graph nodes."
- [Template agent workflows](https://adk.dev/agents/workflow-agents/) / the `LoopAgent` doc —
  `LoopAgent(sub_agents, max_iterations)`, `exit_loop` + `actions.escalate`, completion-phrase.
- [Graph-based workflows](https://adk.dev/graphs/), [Workflows overview](https://adk.dev/workflows/).
