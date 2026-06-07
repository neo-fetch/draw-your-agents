# Design — Loop node (generate → critic → revise), via dynamic workflow (feature #3)

**Status:** architect design note (no code). Supersedes the earlier `LoopAgent`-based draft —
**that was wrong.** Ground truth is the user's proven [`exploring/generic-workflow.py`](../exploring/generic-workflow.py),
which works against real `google-adk==2.0.0`. Implementing session(s) append their own ADR(s).

**Goal:** a **self-contained `loop` node** that generates an output, then iteratively critiques and
revises it until an LLM critic approves (or a max-iteration cap). v1 mirrors the working file 1:1:
**generator + critic + reviser**, **LLM critic only** (no deterministic check yet).

**Breaks two `CLAUDE.md` rules deliberately** — it adds an ADK **dynamic workflow** (the scoped-out
`@node` / `ctx.run_node` / Python-loop API) *contained inside one node*, and it's the biggest
`packages/*` change yet. Golden tests + the ADR-0021 fidelity check are the gate. The win: the loop
is hidden inside one `@node`, so the **outer graph stays a DAG** (invariant 4 still holds at the
graph level).

---

## Ground truth: what actually works (`generic-workflow.py`)

NOT `LoopAgent`. The proven pattern is a **dynamic-workflow orchestrator**:

```python
from google.adk import Context, Workflow
from google.adk.agents import LlmAgent
from google.adk.workflow import START, node

@node(rerun_on_resume=True)
async def <N>_orchestrator(ctx: Context):
    generator = LlmAgent(model=…, name="…", instruction=…, input_schema=GenIn,  output_schema=Payload, output_key=…)
    critic    = LlmAgent(model=…, name="…", instruction=…, input_schema=CritIn, output_schema=CriticOut, output_key=…)
    reviser   = LlmAgent(model=…, name="…", instruction=…, input_schema=RevIn,  output_schema=Payload, output_key=…)

    specs = ctx.state.get("<inputKey>", …)
    raw = await ctx.run_node(generator, GenIn(specifications=specs))
    current = validate_node_output(Payload, raw)

    for _ in range(<maxIterations>):
        crit = validate_node_output(CriticOut, await ctx.run_node(critic, CritIn(current=current, specifications=specs)))
        if crit.status == "<approvalPhrase>":
            ctx.state["<outputKey>"] = current.model_dump(); return
        revised = await ctx.run_node(reviser, RevIn(current=current, revision_feedback=crit.feedback))
        current = validate_node_output(Payload, revised)
    raise RuntimeError("…failed after <maxIterations> rounds")

Workflow(name=…, edges=[(START, <N>_orchestrator)])
```

Salient facts the codegen must honor:
- **Dynamic API**: `@node(rerun_on_resume=True)` on an `async def(ctx: Context)`; sub-agents run via
  `await ctx.run_node(agent, typed_input)`; loop is a Python `for`; success = `critic.status ==
  approvalPhrase` → write `ctx.state[outputKey]` + `return`; exhaustion → `raise RuntimeError`.
- **Typed pydantic I/O**: each sub-agent has `input_schema`/`output_schema`/`output_key`; the
  orchestrator passes/validates them via a `validate_node_output(schema_cls, raw)` helper (coerces
  dict/BaseModel → the pydantic class). This composes with our **nested-schema** support (#2): the
  payload can be a user schema with nested fields.
- **`Agent` vs `LlmAgent`**: the file uses `LlmAgent`. Our existing codegen uses `Agent`. v1 loop
  sub-agents follow the file → `LlmAgent` (confirm both are import-valid in the fidelity step).
- The orchestrator **is one node** in `Workflow(edges=…)`; its sub-agents are **not** graph nodes —
  they're built/run inside the orchestrator (encapsulated, exactly as the file does).

## IR — a new `loop` node type

```ts
// NodeType gains "loop"
interface LoopSubAgent { model: string; instruction: string; }   // agent-shaped (respects agents)
interface LoopConfig {
  description?: string;
  maxIterations: number;          // integer ≥ 1
  approvalPhrase: string;         // default "APPROVED"
  inputType: TypeRef;             // what the loop consumes (the "specifications") — "str" or a schema
  payloadType: TypeRef;           // what is generated & refined (the loop's output) — usually a schema
  generator: LoopSubAgent;
  critic:    LoopSubAgent;
  reviser:   LoopSubAgent;
}
```
Self-contained (the chosen shape): the node owns all three sub-agents. The **critic's output schema
is canonical** (`{ status: str, feedback: str }`) — codegen-generated, never user-authored; `status`
gating is the termination contract. `inputType`/`payloadType` reuse the existing `TypeRef` resolver
(scalar or declared schema — including nested ones from #2).

## Codegen (the real work — parameterize `generic-workflow.py`)

For a `loop` node `N`:
- **schemas.py:** emit the canonical `<N>_CriticOutput(BaseModel){ status: str; feedback: str }` and
  the input-wrapper schemas the orchestrator passes (`<N>_GenInput`, `<N>_CriticInput`,
  `<N>_ReviserInput`) referencing `payloadType`. `payloadType`/`inputType` user schemas already emit
  via the #2 topological path; the `<N>_*` wrappers join them (and participate in topological order
  since they reference `payloadType`).
- **A loop module (or workflow.py):** the `validate_node_output` helper (once), the three `LlmAgent`
  builds, and the `@node async def <N>_orchestrator(ctx)` with the for-loop. Imports
  `from google.adk.workflow import START, node` and `from google.adk.agents import LlmAgent`,
  `from google.adk import Context`.
- **workflow.py:** `N`'s orchestrator symbol goes into `Workflow(edges=…)` wherever the node sits.
- **Data-flow note (refinable scaffold):** the file reads input from `ctx.state["specifications"]`
  (entry orchestrator). For the generated project the loop is the self-contained unit; v1 wires the
  canonical state keys and the user refines the spec/state seeding if needed — the project's "at
  worst a functioning baseline" promise. (Confirmed working in the file.)

## Validator (new codes)

For a `loop` node: `LOOP_BAD_MAX_ITERATIONS` (int ≥ 1), `LOOP_MISSING_APPROVAL_PHRASE` (non-empty),
generator/critic/reviser each present with a non-empty `model` (reuse the agent model check), and
`inputType`/`payloadType` resolve via the existing ref check. Generated symbols (`<N>_orchestrator`,
`<N>_CriticOutput`, …) join the **flat global namespace** (ADR-0017) — no collisions. Graph checks
treat the loop node like any node (one input/one output; DAG unaffected — the loop is internal).

## UI (apps/web — slice 3-C)

- **Palette:** a "Loop" entry (new `NodeType`; palette/drag-drop/minting extend once `addNode` has a
  default `LoopConfig`).
- **Inspector `LoopForm`:** `maxIterations`, `approvalPhrase` (default "APPROVED"), `inputType` +
  `payloadType` `TypeRefSelect`s (reuse the existing widget; offers schemas incl. nested), and three
  sub-agent sub-forms (generator/critic/reviser → model + instruction each, reusing agent widgets).
- **Canvas:** `loop` color + a ↻ badge (reuse the `data-node-type` hook).

## Verification

- **Golden test:** a `critic-loop.ir.json` fixture (one `loop` node + a `payloadType` schema)
  whose generated project structurally matches `generic-workflow.py` — the `@node` orchestrator, the
  three `LlmAgent`s, the canonical `CriticOutput`, the `for`-loop with the approval-phrase check, and
  `N` in `Workflow(edges=…)`.
- **Validator spec:** bad max_iterations, empty approval phrase, missing sub-agent model, unresolved
  payloadType.
- **Fidelity (ADR-0021):** the generated project imports + constructs under real
  `google-adk==2.0.0` and the `@node`/`Workflow` shape matches the proven file. User runs it; high
  confidence since codegen is parameterized from working code.
- **UI:** drag a Loop node, fill the fields, Preview shows the orchestrator scaffold; Save/Load
  round-trips.

## Slice plan

- **Slice 3-B — packages.** `loop` `NodeType` + `LoopConfig` (types + JSON schema); validator codes;
  codegen (canonical schemas + `validate_node_output` + three `LlmAgent`s + `@node` orchestrator
  for-loop + place `N` in `Workflow`); `critic-loop` golden fixture mirroring `generic-workflow.py`;
  fidelity extension. Ends green on `npm test`. Appends an ADR.
- **Slice 3-C — web.** `addNode` default `LoopConfig`; palette "Loop"; inspector `LoopForm`; canvas
  color + ↻ badge; Save/Load round-trip; headless test that a dropped loop node `compile()`s to the
  orchestrator scaffold. Appends an ADR.

## Out of scope (noted)
The deterministic check hook (`run_deterministic_compile_test`) — v1 is critic-only; LoopAgent
templated path (rejected in favor of the proven dynamic API); coordinator delegation; var-chips
inside loop sub-agents; configurable sub-agent I/O schemas (critic output is canonical); mid-graph
input-passing into a dynamic node (v1 is the self-contained shape).

## Sources / ground truth
- [`exploring/generic-workflow.py`](../exploring/generic-workflow.py) — the proven dynamic-workflow
  generate/validate/revise loop (authoritative).
- [Dynamic workflows](https://adk.dev/graphs/dynamic/), [Graph-based workflows](https://adk.dev/graphs/).
