# Decision Log (ADRs)

Append-only. Each entry: context → decision → consequences. Newest at the bottom.
A later session must not silently reverse one of these without adding a superseding entry.

---

## ADR-0001 — The IR is the canonical hub
**Context:** Visual builder, draw.io importer, and code generator could be wired point-to-point,
doubling every feature and bug.
**Decision:** All inputs produce a single versioned **Graph IR** (`packages/ir`). Validation,
codegen, and save/load operate only on the IR.
**Consequences:** draw.io import and visual editing become the same feature; validation and
codegen are written once. The IR JSON Schema is the contract of record.

## ADR-0002 — Scope out ADK dynamic workflows
**Context:** ADK's dynamic API (`@node`, `ctx.run_node`, `while`/recursion) is imperative Python.
**Decision:** v1 supports only the **declarative** subset (sequence, router, parallel, join,
human input, nested workflow, tools). Dynamic workflows are out of scope.
**Consequences:** Clean, closeable visual surface; no attempt to render loops/recursion as nodes.

## ADR-0003 — Codegen = fragment templates + post-processing, client-side
**Context:** Whole-file copy-and-edit can't handle variable node cardinality; pure AST output is
unreadable; LLM generation is non-deterministic.
**Decision:** Generate via per-node template fragments assembled by an orchestrator, then
post-process: import dedupe → `black` format → syntax check. Generation runs **client-side (TS)**
for a live preview with no server dependency in the core loop.
**Consequences:** Output is idiomatic and refinable. Templates are stored as data.

## ADR-0004 — Trustworthy v1 via a Python fidelity service
**Context:** User requirement: v1 must be trustworthy from day one. Client-side TS cannot know
whether real ADK will accept the generated code.
**Decision:** Ship, in v1, a thin Python service that `black`-formats, `compile()`-checks, and
**dry-run constructs the `Workflow` object** (no model calls) to confirm ADK acceptance. The
client-side pipeline remains the fast path; the service is the trust gate before download.
**Consequences:** Adds a backend to v1 (not deferred). "Looks valid" becomes "ADK accepts it."

## ADR-0005 — Frontend stack: React Flow + Lexical + Zustand
**Decision:** React Flow (canvas/nodes/typed handles), Lexical (prompt editor with inline
variable-chip atoms), Zustand (IR store as single source of truth).
**Consequences:** Variable chips are first-class editor nodes; canvas/inspector/preview are
projections of the IR store.

## ADR-0006 — Non-adjacent variables: schema-passing first
**Decision:** v1 variables resolve to fields of a reachable upstream node's `output_schema`,
threaded forward via schemas. Session-`state` variables are deferred to Phase 3.
**Consequences:** Simpler data model first; `state` chips added as a second variable category later.

## ADR-0007 — draw.io: import only
**Decision:** v1 parses draw.io mxGraph XML into IR. Export back to draw.io is deferred.

## ADR-0008 — Prompt variables always rendered source-bound
**Context:** ADK supports `{Schema.field}` and `<Schema.field from node_name>`.
**Decision:** The generator always emits the source-bound `<Schema.field from node_name>` form.
**Consequences:** Unambiguous data provenance even when multiple nodes share a schema.

## ADR-0009 — IR is a plain directed graph; the edges compiler linearizes it
**Context:** ADK's `edges` rows are sequence-chains, route maps, and fan-in/out — not a plain
edge list.
**Decision:** The IR stores nodes + pairwise edges (`{from, to, route?}`, with `from` possibly the
literal `"START"`). A dedicated **edges compiler** in `packages/codegen` collapses linear chains,
expands routers into route maps, and handles join/parallel into ADK `edges=[...]` rows.
**Consequences:** The edges compiler is the highest-risk module; it gets golden-file tests.

## ADR-0010 — Edges compiler output: structured rows + a thin renderer; black owns final formatting
**Context:** The edges compiler must be golden-testable and feed the assembler, but ADK's `edges`
rows ultimately become Python text that the pipeline runs through `black` ([ADR-0003](DECISIONS.md)).
**Decision:** `compileEdges(ir)` returns a structured `EdgeRow[]` (each row a list of `RowMember`s:
`{kind:"start"}` or `{kind:"node",name}`), and a separate `renderEdgeRows` emits a **compact**
canonical fragment `edges=[(...)]`. The renderer does not pretty-print — line wrapping/trailing
commas are left to `black` in the post-process step. Slice 1 implements **linear-chain collapse**
only: a single START entry threaded through nodes that each have one in-edge and one out-edge.
Routers (route edges), parallel fan-out (repeated START / multi-out), and joins (fan-in) are
**rejected with `EdgesCompilerError`** rather than mis-compiled, so later slices fail loud.
**Consequences:** Golden files assert the rendered fragment (the spec); the structured form stays
available for the assembler and future router/join/parallel slices. The compiler does not
re-validate IR invariants (reachability, DAG) — that is the validator's job ([ADR-0001](DECISIONS.md)).

## ADR-0011 — `packages/codegen` runs on Node's native TypeScript (explicit `.ts` specifiers)
**Context:** Node ≥23 (here v26) executes `.ts` directly via type-stripping, but requires the real
on-disk extension in relative imports and does **not** rewrite `.js`→`.ts`. IR types are consumed
type-only, so they erase at runtime.
**Decision:** codegen source and tests use explicit `.ts` import specifiers and import IR types via
`import type { … } from "@graphical-agents/ir"` (erased at runtime — no install needed to run tests).
Tests use the built-in `node:test` runner; `npm test` runs `python3 check_ir.py` + `node --test`.
**Consequences:** Golden tests are green from a cold checkout with zero `npm install` / build step.
Bundling for `apps/web` (Vite) and any `tsc` typecheck resolve `.ts`/workspace types normally; this
diverges from `packages/ir`'s tsc-emit `.js` specifiers, which is fine since codegen never imports
IR at runtime.

## ADR-0012 — Project assembler: fragment templates per node, scaffold + py_compile trust gate
**Context:** Slice 2 of codegen turns the IR into the runnable project file set (ARCHITECTURE.md §5),
scoped to the same constructs the edges compiler supports (ADR-0010): linear graphs of agent +
function nodes.
**Decision:** `generateProject(ir)` returns a `Map<path, content>` for the seven-file set
(`schemas.py`, `functions.py`, `agents.py`, `workflow.py`, `requirements.txt`, `.env.example`,
`README.md`). Each `.py` module is assembled from **per-node template fragments** (`renderSchema` /
`renderFunction` / `renderAgent` in `fragments.ts`), never string-splicing (ADR-0003). A fragment is
a pure `{ imports, code }`; the assembler dedupes/groups imports isort-style (stdlib → third-party →
local) and stitches bodies. Scope is enforced loud, mirroring ADR-0010: `compileEdges` rejects
out-of-slice graph *shapes*; `generateProject` additionally rejects out-of-slice node *types*
(tool/workflow) with `CodegenError`. The golden files under `test/golden/city-time/` are the spec;
a separate trust check shells out to `python3 -m py_compile` on every generated `.py` (py_compile
**only** — it proves syntax without importing ADK).
**Conventions chosen (assumptions to revisit with the fidelity service, ADR-0004):**
- ADK import surface emitted as `from google.adk import Agent | Event | Workflow`; cross-module
  refs as flat `from schemas|agents|functions import …` (project root on `sys.path`).
- Function nodes: signature `def name(node_input: <inputType>) -> Event:`; `null` body → a TODO
  stub returning `Event(<channel>=<channel>)` where channel honors `emits` (`output` vs `message`),
  with an annotated `... ` placeholder so the return type is visible.
- Agent prompt rendered source-bound `<Schema.field from node>` (ADR-0008); `"str"` schema refs
  map to the builtin `str`, named refs to the pydantic class; `null` `inputSchemaRef` omits
  `input_schema`. `modelParams` map to snake_case kwargs.
- **`black` is not run yet** — it is the post-process step (ADR-0003); fragments emit black-shaped
  text (4-space indent, double quotes, trailing commas, 2 blank lines around top-level def/class)
  so that step is a near no-op.
**Consequences:** New node types/constructs are added one fragment + one golden at a time. The
edges compiler stays the single linearizer feeding `workflow.py`. The py_compile gate is the
headless precursor to the full Python fidelity service (ADR-0004).

## ADR-0013 — Authoritative TypeScript validator supersedes the Python stand-in
**Context:** ADR-0001 names the validator as the IR spec, but it only existed as a Phase-0
stand-in (`scripts/check_ir.py`) written before Node was installed. Node is now available (v26,
runs `.ts` natively — ADR-0011), so the spec belongs in TypeScript inside `packages/ir`, the
keystone every package depends on.
**Decision:**
- `validate(ir: GraphIR): ValidationResult` in `packages/ir/src/validate.ts` is the **authoritative**
  IR validator. It ports every invariant from `check_ir.py` and docs/IR-SCHEMA.md §Invariants and
  returns **structured findings** (`{ severity, code, message, nodeId? }`) — not thrown strings —
  keyed by stable `ValidationCode`s. `scripts/check_ir.py` is **superseded**: kept on disk for
  reference, removed from the gate, banner added. New invariants go in `validate.ts`.
- `npm run check:ir` runs the TS validator over `packages/ir/fixtures/*.ir.json` via
  `scripts/check-ir.ts` (native TS, no install). `npm test` = `check:ir` + `test:ir`
  (validator spec tests) + `test:codegen` (golden tests).
- Codegen gains `compile(ir)` (`packages/codegen/src/compile.ts`) = **validate → throw
  `ValidationError` on errors → `generateProject`**. `generateProject` stays **pure** and does not
  re-validate (reaffirms ADR-0010/ADR-0001 — the validator owns the spec, codegen trusts a clean IR).
- `severity: "warning"` is **reserved** for the join-failsafe and incompatible-integration rules
  (ARCHITECTURE.md §7). Those constructs are Phase 3, so the warning pass is **stubbed** (codes
  exist, emits nothing yet).
**Extends ADR-0011:** to stay green from a cold checkout with no `npm install`, `compile.ts`
imports `validate` at runtime via a **relative `.ts` specifier** (`../../ir/src/validate.ts`), not
the `@graphical-agents/ir` package specifier (whose `main` points at an unbuilt `dist/`). The
`import type { GraphIR }` from the package specifier still erases. So ADR-0011 broadens from
"codegen imports IR type-only" to "codegen may import IR *source* at runtime via a relative `.ts` path."
**Consequences:** One typed, golden-testable IR spec; the visual builder and draw.io importer can
surface located findings; codegen refuses to generate from an invalid IR. The Python script is a
historical reference, not a second source of truth.

## ADR-0014 — Router slice: route-map row form + branch-target assumptions
**Context:** Routers are the first non-linear construct ([ADR-0009](DECISIONS.md)). The edges
compiler and assembler previously rejected them loud ([ADR-0010](DECISIONS.md),
[ADR-0012](DECISIONS.md)); this slice generates them end to end. The IR validator already enforced
the router route⇔edge-label invariants (IR-SCHEMA §7), so it was unchanged — the new
`packages/ir/fixtures/routing.ir.json` ("process_message → router → {BUG, CUSTOMER_SUPPORT,
LOGISTICS}") exercises that existing path.
**Decision:**
- **Edges compiler.** A router terminates the entry sequence chain and contributes a **second row**
  `(router, {"ROUTE": target, ...})` — the ADK route map. The structured `RowMember` model gains a
  third kind `{kind:"routeMap", entries:[{route,target}]}` (not a renderer hack —
  [ADR-0010](DECISIONS.md)). Rendered form: **quoted route keys, bare target symbols**
  (`{"BUG": handle_bug, ...}`). **Entry order follows the router's declared `routes` array**
  (deterministic), *not* edge order — the validator guarantees the two sets match.
- **Branch targets must be terminal in this slice.** A route target with its own out-edges is a
  branch *continuation* we don't yet linearize; `compileEdges` throws `EdgesCompilerError` rather
  than drop it. Nested routers (a router as a branch target chains a second route row), joins, and
  parallel stay rejected loud. `compileEdges` keeps rejecting `join`/`humanInput` and non-router
  fan-out / multiple-START.
- **Codegen.** Routers render into **`functions.py`** (they are functions returning `Event`) via a
  new `renderRouter` fragment: `def <name>(node_input: <inputType ?? str>) -> Event:`, `null` body →
  a TODO stub `route: str = ...; return Event(route=route)` that names the declared routes. Function
  and router defs interleave in **IR node order**. `generateProject` now allows
  `agent`/`function`/`router`; `tool`/`join`/`humanInput`/`workflow` still raise `CodegenError`.
  `workflow.py` imports router symbols from `functions` (they appear in the edge rows); branch-target
  agents import from `agents` as before.
**ADK assumptions to revisit with the fidelity service ([ADR-0004](DECISIONS.md)):** that the route
row is literally `(router_symbol, {route_string: target_symbol})` and that `Event(route=...)` alone
moves control to the mapped target. How *data* flows into a branch (the router's `node_input` vs. a
separate payload) is not yet modelled — branches here take whatever ADK forwards positionally.
**Consequences:** The compiler emits multi-row `edges` for the first time; goldens
(`test/golden/routing.edges.txt`, `test/golden/routing/`) pin the row form and the generated project,
and the py_compile trust gate now covers the routing fixture too.

## ADR-0015 — Parallel fan-out + JoinNode: row form, import surface, failsafe warning
**Context:** Parallel fan-out (repeated START) and `JoinNode` (fan-in) are the second non-linear
construct ([ADR-0009](DECISIONS.md)), completing the parallel path. The edges compiler and assembler
previously rejected them loud ([ADR-0010](DECISIONS.md), [ADR-0012](DECISIONS.md)); this slice
generates them end to end. The IR fixture `packages/ir/fixtures/parallel.ir.json` (START →
{task_a, task_b, task_c} → my_join_node → final_task_d) exercises the full path.
**Decision:**
- **Fan-out row form.** Each parallel branch gets its own START row: `("START", branch_node, ...,
  join_node)`. The join node terminates every branch row (it is the last member). A separate
  **continuation row** `(join_node, final_node, ...)` begins at the join and chains forward. Multi-hop
  branches (START → A → B → join) are supported — the chain walker walks until it reaches the join.
  The `RowMember` model from [ADR-0010](DECISIONS.md) is unchanged — fan-out rows use existing
  `{kind:"start"}` and `{kind:"node"}` members.
- **JoinNode import surface.** `JoinNode(name=...)` from `google.adk.workflow` (not `google.adk`).
  The join declaration is rendered **inline in `workflow.py`** before the `Workflow(...)` call, since
  JoinNode is a workflow building block, not an agent or function. No cross-module import needed.
- **`JOIN_MISSING_FAILSAFE` warning (ARCHITECTURE.md §7).** The validator's reserved warning code
  is now implemented. It fires on two conditions: (1) an agent node with `null`/missing
  `outputSchemaRef` feeding a join, and (2) a function node with `emits: "message"` feeding a join
  (the `message` channel does not produce output that JoinNode waits for). Function nodes emitting
  `"output"` and router nodes are inherently safe. `parallel.ir.json` is warning-free by
  construction; `fixtures/invalid/join-missing-failsafe.ir.json` trips exactly one warning.
- **Edges compiler.** `rejectUnsupported` no longer blocks `join` nodes. `humanInput` remains
  rejected. The compiler detects `startTargets.length > 1` and delegates to `compileParallel`, which
  walks each branch to the join. Single-entry linear and router paths are unchanged.
- **Codegen.** `generateProject` now allows `agent`/`function`/`router`/`join`;
  `tool`/`humanInput`/`workflow` still raise `CodegenError`. A new `renderJoin` fragment emits
  `JoinNode(name=...)`. The project assembler (`workflowModule`) renders join declarations before the
  `Workflow(...)` call and dedupes the `google.adk.workflow` import.
**ADK assumptions to revisit with the fidelity service ([ADR-0004](DECISIONS.md)):** that
`JoinNode` is importable from `google.adk.workflow`; that the fan-out row form `("START", branch,
join)` repeated per branch is the correct ADK `edges` encoding; that `JoinNode(name=...)` is the
minimal constructor call.
**Consequences:** The compiler handles all three row forms (linear chain, route map, parallel
fan-out + join); goldens (`test/golden/parallel.edges.txt`, `test/golden/parallel/`) pin the
row form and the generated project, and the py_compile trust gate now covers the parallel fixture.
The warning channel is no longer stubbed — callers can surface `JOIN_MISSING_FAILSAFE` findings.

## ADR-0016 — HumanInput: zero-arg generator yielding RequestInput; payload/responseSchema ref checks
**Context:** `humanInput` is the last v1 declarative leaf
([ARCHITECTURE.md §2](ARCHITECTURE.md)); the edges compiler
([ADR-0010](DECISIONS.md)) and assembler ([ADR-0012](DECISIONS.md)) were still
rejecting it loud. The IR validator already enforced `HUMANINPUT_MISSING_MESSAGE`
but did not resolve `payloadRef` / `responseSchemaRef` against declared schemas.
The slice closes both gaps end to end. The fixture
`packages/ir/fixtures/human-input.ir.json` (`START → ask_user → process_response`)
is the worked example.
**Decision:**
- **Emission surface.** A humanInput node renders into `functions.py` as a
  **zero-arg generator** that yields a single `RequestInput`:
  ```python
  def ask_user():
      yield RequestInput(
          message="...",
          payload=<PayloadSchema>,           # omitted when payloadRef is null
          response_schema=<ResponseSchema>,  # omitted when responseSchemaRef is null
      )
  ```
  No `node_input` parameter, no `Event` return: per the ADK docs
  (https://adk.dev/graphs/human-input/) the runtime pauses at the `yield` and
  forwards the user's response to the next node's `node_input`. **Import surface:**
  `from google.adk.events import RequestInput`. Null `payloadRef` /
  `responseSchemaRef` → omit the kwarg (matching how `renderAgent` handles
  `inputSchemaRef: null`).
- **Edges compiler.** A humanInput node is a plain linear-chain member —
  `{kind:"node", name}`, no new `RowMember` kind. `rejectUnsupported` is
  **removed** because the linearizer now handles every declared node type the
  validator lets through (`tool`/`workflow` are Phase 3 and would be rejected by
  the assembler's type whitelist before reaching the compiler).
- **Validator addition.** New stable codes
  `UNKNOWN_HUMANINPUT_PAYLOAD_REF` and `UNKNOWN_HUMANINPUT_RESPONSE_SCHEMA_REF`,
  emitted via the existing `refOk(ref, allowNull=true)` helper. `null`, omitted,
  `"str"`, and any declared schema name are all valid — `"str"` is accepted for
  consistency with agent/function ref slots, even though the canonical docs
  example uses null-or-pydantic. No `inputType` inference for humanInput is
  added in this slice (deferred, same posture as [ADR-0006](DECISIONS.md)).
- **Project assembler.** `humanInput` joins `function` and `router` in
  `functions.py` (interleaved in IR node order) and contributes its symbol to
  `workflow.py`'s `from functions import …` line. Tool and workflow nodes still
  raise `CodegenError`.
**ADK assumptions to revisit with the fidelity service ([ADR-0004](DECISIONS.md)):**
that `RequestInput` is importable from `google.adk.events`; that a zero-arg
generator yielding `RequestInput` (no `Event` wrapper) is the correct
graph-workflow surface; that `payload=` / `response_schema=` are the kwarg
names. Verified against [adk.dev/graphs/human-input/](https://adk.dev/graphs/human-input/).
**Consequences:** Every v1 declarative leaf
([ARCHITECTURE.md §2](ARCHITECTURE.md)) — agent, function, router, join,
humanInput — now compiles end to end. Goldens
(`test/golden/human-input.edges.txt`, `test/golden/human-input/`) pin the row
form and the generated project; the `py_compile` trust gate now covers the
human-input fixture too. `tool` and `workflow` nodes remain Phase 3.

## ADR-0017 — Nested Workflow: sub-IR in `config.graph`, flat global namespace, recursive validator
**Context:** `workflow` is the only recursive node type in the v1 taxonomy
([ARCHITECTURE.md §2](ARCHITECTURE.md)) and the only declarative leaf still
rejected loud after [ADR-0016](DECISIONS.md). It also forces an IR-shape
decision the brief explicitly flags: how does a workflow node carry its
sub-graph, and what is the namespace relationship between the parent and the
child? This ADR records the IR + validator half; the edges/codegen half is in
ADR-0018 (forthcoming) on the same branch.
**Decision:**
- **IR shape.** A `workflow` node's config is `{ description?, graph: GraphIR }` —
  the sub-graph is a **complete nested `GraphIR`** (its own START, nodes, edges,
  schemas). The JSON Schema expresses this with a recursive `"graph": { "$ref": "#" }`,
  so the same schema validates parents and children with no duplication.
- **Single flat global namespace** for node `name`s **and** schema names across
  parent + every nested sub-graph. Rationale: codegen writes flat
  `agents.py`/`functions.py`/`schemas.py` modules with one symbol per node
  name; cross-level collisions would silently clobber. The validator enforces
  this by threading `globalNames` / `globalSchemas` sets through recursion and
  emitting `DUPLICATE_NODE_NAME` / `DUPLICATE_SCHEMA_NAME` at the **second**
  occurrence (so the offending duplicate is flagged where it is introduced).
  Schema **lookups** (`refOk`, var segments) stay **local** to each sub-graph —
  a sub-graph must self-contain the schemas it references; the global sets
  exist only to detect collisions.
- **Validator recursion.** `validate(ir)` delegates to a private
  `validateGraph(ir, ctx)` worker that performs every existing IR-SCHEMA
  invariant on `ir`, then recurses on each `workflow` node's `config.graph` with
  a longer `pathPrefix`. The recursion happens **after** this level's per-type
  switch so all of this level's names are seeded into `globalNames` before the
  child looks for duplicates.
- **Finding location.** `Finding.nodeId` is composed as
  `<parentId>/.../<nodeId>` — one segment per nesting level. The `Finding`
  shape is unchanged; this is purely a string convention so the visual builder
  and draw.io importer can locate a finding back to its enclosing workflow
  node. The MISSING_TOP_LEVEL_KEY short-circuit is now relative to findings
  **added in this call** (`findings.length > findingsAtEntry`), so a nested
  call is not aborted by findings the parent has already accumulated.
- **New code.** `WORKFLOW_MISSING_GRAPH` — fires when `config.graph` is absent
  or not an object; recursion is skipped for that node.
**ADK assumptions to revisit with the fidelity service ([ADR-0004](DECISIONS.md)):**
that a nested `Workflow(...)` object is constructed identically to the root
(just bound to a non-`root_agent` symbol) and that the parent references it by
bare symbol in its `edges` row. Pinned in ADR-0018 with the codegen half.
**Consequences:** The IR contract is now genuinely recursive — the visual
builder and draw.io importer can offer sub-canvas editing without a separate
shape. The fixture `packages/ir/fixtures/nested.ir.json` (parent
`START → preprocess → nested_workflow → finalize`, nested
`START → inner_step_a → inner_step_b`) is the worked example; validator tests
pin recursion, cross-level dup detection, and the path-prefix convention.
Codegen still rejects `workflow` loud — that is ADR-0018's job.

## ADR-0018 — Nested Workflow codegen: per-sub-graph `compileEdges`, deepest-first inline Workflow assignments, flat shared modules
**Context:** Codegen half of the nested-workflow slice, building on the IR /
validator half ([ADR-0017](DECISIONS.md)). The brief asks how a `workflow`
node's sub-graph compiles, where its agents / functions / schemas live, and in
what order the `Workflow(...)` assignments are emitted so the parent's edge
rows can reference them by symbol.
**Decision:**
- **Edges compiler.** A `workflow` node is a plain linear-chain member in its
  parent's rows — `{kind:"node", name}`, no new `RowMember` kind. `compileEdges`
  does **not** recurse into `config.graph`; the project assembler walks
  workflow nodes separately and calls `compileEdges` per sub-graph. This keeps
  the linearizer free of cross-cutting concerns and matches how routers /
  joins / humanInputs each kept the compiler's surface small.
- **Project assembler — flat shared modules.** Every level's agents,
  functions, routers, humanInputs, and schemas flow into the shared
  `agents.py` / `functions.py` / `schemas.py` modules with no qualification.
  Justified by the flat global namespace ([ADR-0017](DECISIONS.md)): node
  names are globally unique across nesting levels, so one symbol per node is
  collision-free. Module-body order is DFS preorder (parent's nodes, then the
  sub-graph at the point of its workflow node, then the rest), so the modules
  read in a natural top-to-bottom order.
- **Inline `Workflow(...)` assignments, deepest-first.** Each nested workflow
  is emitted inline in `workflow.py` as
  `<workflow_node_name> = Workflow(name="<workflow_node_name>", edges=[...])`,
  in **deepest-first** post-order so a nested Workflow is bound before any
  parent Workflow that references it — same dependency-order rule used for
  `JoinNode` inline declarations ([ADR-0015](DECISIONS.md)). The root is the
  last assignment and renders as `root_agent = Workflow(...)`. Each level's
  joins are emitted immediately before that level's Workflow assignment, so a
  nested workflow that contains a `JoinNode` brings its join declaration with
  it. No cross-module import is needed for nested Workflows — they live in the
  same file as the root.
- **No fragment indirection for nested Workflows.** Unlike `renderJoin`, the
  nested-Workflow body is built inline in `workflowModule` from the
  `WorkflowContext` (symbol + compiled rows). Adding a `renderNestedWorkflow`
  fragment would duplicate the existing
  `<symbol> = Workflow(\n    name=...,\n    edges=[...],\n)` template — the
  context loop is the simpler shape.
- **Out-of-slice node types.** The assembler now allows
  `agent`/`function`/`router`/`join`/`humanInput`/`workflow`. `tool` is the
  **only** remaining Phase 3 type and is the sole `CodegenError` case.
**ADK assumptions to revisit with the fidelity service ([ADR-0004](DECISIONS.md)):**
that a nested `Workflow(...)` object is constructed identically to the root
(just bound to a non-`root_agent` symbol) and that the parent references it by
bare symbol in its `edges` row exactly like a function or agent reference.
**Consequences:** Every v1 declarative node type now compiles end to end —
`tool` is the only remaining Phase 3 type. Goldens
(`test/golden/nested.edges.txt`, `test/golden/nested/`) pin the parent rows
and the generated project; the `py_compile` trust gate covers the nested
project too. A manual three-level sanity check (root → middle → innermost)
confirms deepest-first emission and DFS-preorder module bodies generalize to
arbitrary depth.

## ADR-0019 — Tool node: `FunctionTool` wrapping `<name>_impl`, inline in `workflow.py`
**Context:** `tool` is the last v1 declarative leaf
([ARCHITECTURE.md §2](ARCHITECTURE.md)) — after [ADR-0018](DECISIONS.md) it was
the only node type still rejected loud by `generateProject`'s type guard and
absent from the validator's per-type switch. The ADK docs surface
`FunctionTool(func=...)` from `google.adk.tools` for the agent-tool use case,
but do **not** specify how a Tool is used as a graph node. This slice picks a
minimal defensible shape and records it as an explicit assumption to revisit
with the fidelity service ([ADR-0004](DECISIONS.md)), mirroring how
[ADR-0016](DECISIONS.md) pinned `RequestInput` and [ADR-0015](DECISIONS.md)
pinned `JoinNode`.
**Decision:**
- **IR shape.** `ToolConfig = { description?, inputType, outputType, body? }`
  — structurally identical to `FunctionConfig` minus the `emits` channel
  choice (tools always emit on `output`). `tool.ir.json`
  (`START → fetch_data (tool) → summarize (agent)`, `Article` schema) is the
  worked example.
- **Validator.** New `TOOL_UNKNOWN_INPUT_TYPE` / `TOOL_UNKNOWN_OUTPUT_TYPE`
  codes; a `case "tool":` branch in the per-type switch runs `refOk` on
  `inputType` / `outputType` exactly like `function`. Name uniqueness,
  reachability, DAG, and edge checks are type-blind and already cover `tool`
  generically.
- **Edges compiler.** A tool node is a plain linear-chain member —
  `{kind:"node", name}`, no new `RowMember` kind. The chain walker already
  treats anything that is not a `router` or `join` as linear, so no source
  change was needed.
- **Emission surface.** A tool node compiles to two pieces:
  ```python
  # functions.py
  def fetch_data_impl(node_input: str) -> Event:
      """..."""
      # TODO: implement fetch_data — body not yet provided in the IR.
      output: Article = ...
      return Event(output=output)

  # workflow.py — inline, in the same slot as JoinNode declarations
  fetch_data = FunctionTool(func=fetch_data_impl)
  ```
  The edge symbol is the wrapper (`fetch_data`), so parent `edges` rows
  reference it directly like any other node. The underlying impl is named
  `<node_name>_impl` and lives in `functions.py`; the suffix is a
  codegen-internal symbol (the flat global namespace from
  [ADR-0017](DECISIONS.md) is over user-facing node `name`s only, so no
  validator rule is needed for it). Import surface:
  `from google.adk.tools import FunctionTool`. Per-context emission order in
  `workflow.py` is **tool wrappers → join declarations → `Workflow(...)`
  assignment**, walked deepest-first ([ADR-0018](DECISIONS.md)) so a nested
  workflow brings its tool wrappers and join declarations with it.
- **Project assembler.** `generateProject`'s rejection list is gone — every
  v1 declarative type is now handled. The remaining type guard only fires on
  malformed IR with an unknown `type` string (the validator's
  `UNKNOWN_NODE_TYPE` is the upstream gate; codegen trusts a clean IR,
  reaffirming [ADR-0013](DECISIONS.md)).
**ADK assumptions to revisit with the fidelity service ([ADR-0004](DECISIONS.md)):**
that `FunctionTool` is importable from `google.adk.tools`; that the
graph-workflow surface for a tool node is the `FunctionTool` *object*
referenced by bare symbol in `edges` rows (like a function or agent); that
the underlying `func=` callable has the function-node signature
`(node_input: <inputType>) -> Event` and emits on the `output` channel. The
ADK docs surveyed (`graphs/`, `graphs/routes/`, `graphs/data-handling/`,
`tools-custom/`) mention "ADK Tools" can be workflow nodes but do not
demonstrate the surface explicitly — this slice's emission is the minimal
shape that compiles cleanly and aligns with `FunctionTool`'s documented
constructor.
**Consequences:** Every v1 declarative node type
([ARCHITECTURE.md §2](ARCHITECTURE.md)) now compiles end to end —
agent, function, router, join, humanInput, workflow, and tool. The codegen
scope log closes here: no `CodegenError` path is reachable from a valid IR.
Goldens (`test/golden/tool.edges.txt`, `test/golden/tool/`) pin the row form
and the generated project; the `py_compile` trust gate now covers the tool
fixture too.

## ADR-0020 — Project bundling: separate black post-process + pure-TS STORE-only zip
**Context:** ADR-0003 names the codegen pipeline as
`IR → edges compiler → fragments → assemble → import dedupe → format (black)
→ syntax check → bundle project scaffold`. Up to this slice the pipeline
stopped at the `GeneratedProject` map: `black` was deferred (ADR-0012 — "not
run yet"), and there was no bundler — the "runnable ADK project (.zip)"
artifact ([ARCHITECTURE.md §5](ARCHITECTURE.md)) had no implementation behind
it. The closing slice also has to be browser-compatible because `apps/web`'s
live preview ([ADR-0003](DECISIONS.md)) will call the bundler client-side.
**Decision:**
- **Format is a separate exported function**, not folded into `compile()`.
  `formatProject(project, opts?)` lives in `packages/codegen/src/format.ts`
  and returns `{ project, status: "formatted" | "skipped" | "unavailable" }`.
  `compile(ir)` stays pure and returns the **unformatted** map — the existing
  goldens pin pre-format output, so they remain the authoritative spec
  (ADR-0010 / ADR-0012). The browser path can call `formatProject` with
  `{ black: "skip" }` to opt out entirely.
- **`black` via `python3 -m black --quiet -` (stdin → stdout).** Same
  shell-out posture as the `py_compile` trust gate (`project.test.ts`); no
  new dependency on the dev environment. The module probes once
  (`python3 -c "import black"`, cached for the process). If unavailable the
  call returns the project unchanged with `status: "unavailable"` and emits a
  single `console.warn` — never throws. Rationale: `npm test` must stay green
  on a cold checkout without `pip install black`. The idempotence test is
  skipped (not failed) when black is missing.
- **Idempotence is the spec.** `format.test.ts` asserts that
  `formatProject(generateProject(ir))` is byte-equal to its input for every
  fixture when black is installed. ADR-0012 already requires fragments to
  emit black-shaped text; this test makes that requirement enforceable. A
  future fragment edit that drifts from black's style will fail this test
  loud — fix the fragment, or re-baseline goldens consciously.
- **Line wrapping moves into the assembler (refines ADR-0010).** ADR-0010
  left line wrapping to black. Idempotence on the goldens forces the
  fragments to actually emit the wrapped shape so black is a no-op. Two
  helpers — `renderImports` in `python.ts` and `renderEdgesBlock` in
  `project.ts` — wrap at the 88-column budget (`BLACK_LINE_WIDTH`) when the
  inline form would overflow. `renderEdgeRows` in `edges.ts` is **unchanged**
  and remains the compact canonical form pinned by `*.edges.txt` goldens —
  it is the structural spec for the edges compiler, while the workflow.py
  assembler owns presentation. routing/workflow.py and parallel/workflow.py
  goldens were re-baselined to the wrapped form; the other four fit in 88
  cols and are byte-identical to before.
- **`.zip` bundler is pure TS, STORE-only**
  (`packages/codegen/src/bundle.ts`). `bundleZip(project, rootDir)` writes
  local file headers + central directory + EOCD with a precomputed CRC-32
  table. No DEFLATE, no `node:zlib`, no `CompressionStream` — only
  `Uint8Array`, `DataView`, and `TextEncoder`, all present in both Node and
  browser lib. Justified by two needs: the same module runs in `apps/web`'s
  live preview, and round-trip golden tests want a deterministic byte output
  (DEFLATE quirks across runtimes would make that brittle). Compression
  buys little on a 7-file project of small `.py` text.
- **`unzipStore` co-located** as a STORE-only reader that pins the round-trip
  spec. It is not a general-purpose unzipper — it handles archives produced
  by `bundleZip` and rejects unknown compression methods loud. The
  round-trip test (`bundle.test.ts`) is the contract: every fixture archives
  to bytes that recover as a map byte-equal to the input, with every path
  prefixed by `${ir.name}/`.
- **CLI lives at `scripts/compile.ts`**, mirroring `scripts/check-ir.ts`
  (Node native TS, no install / build). Pipeline: read fixture → `compile()`
  → `formatProject()` → `bundleZip(..., ir.name)` → `writeFileSync`. Not part
  of `npm test` — `check:ir` + validator + codegen goldens + the new format
  & bundle tests are the gate. The CLI is exercised manually for end-to-end
  smoke checks.
**Open assumption to revisit:** STORE-only zips are larger than DEFLATE.
Revisit if a generated project size ever crosses a threshold the UI download
would notice — at that point swap in `CompressionStream`/`node:zlib` behind
the same `bundleZip` surface and update the round-trip test to compare
recovered contents (not bytes).
**Consequences:** ARCHITECTURE.md §5's pipeline is closed end-to-end. The
codegen package now exports both halves of the post-process tail; the future
visual builder can compose them client-side without any Node-only runtime
deps. The IR → `.zip` artifact is runnable headless via one CLI invocation.

## ADR-0021 — Fidelity verified against real google-adk==2.0.0 (assumptions confirmed)
**Context:** ADR-0012/0016/0019 pinned the emitted ADK API surface as **assumptions** to confirm
against the real package (the deferred ADR-0004 fidelity gate). `py_compile` proved syntax and
`black` proved formatting, but real ADK *acceptance* — that a generated `Workflow(...)` actually
constructs — was unproven.
**Method:** Manual verification (not yet automated). In a clean venv on Python 3.14:
`pip install google-adk==2.0.0` (installs clean), then probed every emitted import path and
constructed `root_agent` for all six fixtures (city-time, routing, parallel, human-input, nested,
tool) with a dummy `GOOGLE_API_KEY`.
**Result — every assumption is CONFIRMED, no generator changes needed:**
- `from google.adk import Workflow | Event | Agent` — all present (top-level exports; the graph
  `Workflow` lives in `google/adk/workflow/_workflow.py`).
- `from google.adk.workflow import JoinNode` — present.
- `from google.adk.events import RequestInput` — present.
- `from google.adk.tools import FunctionTool` — present.
- All six fixtures: `import workflow` succeeds and `root_agent` is a real ADK `Workflow` instance.
**Consequences:** The codegen core is trustworthy for real, not just on paper — the full pipeline
`IR → validate → generateProject → black → .zip` produces code that constructs against real ADK
across the entire v1 declarative taxonomy. The import surfaces in ADR-0012/0016/0019 are no longer
assumptions. **Phase 0 is complete.**
**Follow-up (deferred, low-risk):** wrap this manual check as `scripts/fidelity_check.py` that
imports + dry-run-constructs each fixture's `root_agent`, skipping cleanly when google-adk is absent
(mirrors black's graceful degradation). It is now confirmation, not a bug hunt, so it can wait.

## ADR-0022 — Frontend slice 1: `apps/web` scaffold, IR store as UI source of truth, preview reuses `compile()`
**Context:** Phase 0 closed with the codegen pipeline fully proven end to end against real
`google-adk==2.0.0` ([ADR-0021](DECISIONS.md)). What was still missing was a UI. This slice
introduces `apps/web` — the first frontend package — and proves the architectural spine
**IR store → canvas → inspector → IR → live preview** on one editable field (`agent.config.model`)
against the `city-time` fixture. Variable chips, drag-to-connect, save/load, draw.io, the Lexical
prompt editor, and any field beyond `agent.model` are explicitly out of scope — those are later
slices.
**Decision:**
- **Stack confirmed ([ADR-0005](DECISIONS.md)):** React 19 + React Flow (`@xyflow/react` v12) +
  Zustand v5 + Vite 7 + TypeScript 5. Lexical is deferred — no prompt editor this slice.
- **`apps/web` is the install boundary.** It is the first package that requires `npm install`;
  the headless `packages/*` stay install-free ([ADR-0011](DECISIONS.md), [ADR-0013](DECISIONS.md)).
  The root `npm test` still runs from a cold checkout: `check:ir` + `test:ir` + `test:codegen` +
  the new `test:web`, which uses Node native TS and depends only on relative `.ts` source paths
  (no `zustand`, no React).
- **IR store is the UI's single source of truth** ([ADR-0001](DECISIONS.md)). One Zustand store
  holds one `GraphIR`. Canvas, Inspector, and Preview all read from it; the store is the only
  writer. Typed actions only — this slice ships `setSelectedNode` and `updateNodeConfig(nodeId,
  patch)`. The pure reducer (`applyNodeConfigPatch`) lives in `irReducer.ts`, separately from the
  `zustand` wrapper in `irStore.ts`, so the headless test can exercise the round-trip without
  pulling in `zustand` (and therefore without `npm install`).
- **Preview reuses the existing `compile()` client-side** ([ADR-0003](DECISIONS.md)). On every
  store change, Preview runs `compile(ir)` and renders the selected file from the
  `GeneratedProject` map (default `agents.py`). On `ValidationError`, it renders the structured
  `findings` list — never crashes. No code was added to `packages/codegen` or `packages/ir`; the
  UI inherits the proven core unchanged. Browser-safety of the chain was already pinned by
  [ADR-0020](DECISIONS.md) (`bundle.ts` is Uint8Array-only); `compile` + `generateProject` only
  touch IR, schemas, and string templates.
- **Workspace resolution without a build step (refines [ADR-0011](DECISIONS.md) /
  [ADR-0013](DECISIONS.md)).** `apps/web` imports `GraphIR` and `GraphNode` **type-only** from the
  package specifier (`import type { … } from "@graphical-agents/ir"` — erases at runtime), and
  imports `compile`/`ValidationError` at runtime via the **relative `.ts`** path
  `../../../../packages/codegen/src/index.ts`. The dependency chain has **no runtime `.js`
  specifiers** — `validate.ts`'s only `./types.js` import is type-only, and codegen's source uses
  `.ts` specifiers throughout. So no Vite alias, no regex `.js`→`.ts` rewrite, and no `predev`
  build of `packages/ir` is needed. The `dist/`-pointing `main` in `packages/ir/package.json`
  stays as-is. `vite.config.ts` only widens `server.fs.allow` to the monorepo root so the dev
  server can serve files outside `apps/web`.
- **Reducer-shaped headless test.** `apps/web/test/irStore.test.ts` pins the round-trip the slice
  exists to prove: apply `updateNodeConfig`, validate stays clean, `compile()` reflects the patch
  in `agents.py`; and the negative path — emptying the model surfaces `AGENT_MISSING_MODEL`.
  This is the closest thing the UI has to a golden, and the gate against future inspector edits
  silently breaking the spine.
**Manual smoke check (no automated browser yet):**
1. `cd apps/web && npm install && npm run dev` — Vite opens at the dev URL.
2. The three city-time nodes render at their `ui.{x,y}` positions, edges between them.
3. Click `city_generator` → Inspector shows `model = "gemini-flash-latest"`.
4. Edit it to `"gemini-pro-latest"` → canvas label is unchanged (label is `name`, not `model`),
   but the Preview pane's `agents.py` shows the new string in the `model=` slot.
5. Clear the field → Preview shows the `AGENT_MISSING_MODEL` finding; no crash.
**Open assumptions to revisit:**
- If `packages/ir` ever grows a runtime export that imports a sibling via `.js` specifier (rather
  than `import type`), `apps/web`'s relative-`.ts` chain will trip. At that point the standard
  Vite + Node fix is a regex alias (`/^(\.{1,2}\/.+)\.js$/` → `$1.ts`); add it then, not now.
- The Preview shows the **unformatted** output of `generateProject` (matching the codegen goldens,
  per ADR-0010 / ADR-0012). Wiring `formatProject` is a later slice — same reasoning as keeping
  the goldens authoritative.
**Consequences:** The IR → canvas → inspector → IR → preview spine is closed and exercised by a
headless test. Future slices (drag-to-add, the Lexical prompt editor and variable chips, save/load,
`.zip` download via `bundleZip`, draw.io import) extend this scaffold without re-architecting it.

## ADR-0023 — Inspector slice 2: type-dispatched config form, focused `updateModelParam`, dropdowns mirror `ir.schemas`
**Context:** [ADR-0022](DECISIONS.md) wired the canvas → inspector → preview spine on one editable
field (`agent.config.model`). The next slice widens that proven round-trip to the **complete
config surface** of every v1 declarative node type — without forking the store, growing the
validator, or touching codegen. The IR types in `packages/ir/src/types.ts` are the contract;
this ADR records the three judgment calls made implementing against it.
**Decision:**
- **Focused `applyModelParamPatch` for nested `modelParams`.** `applyNodeConfigPatch` is a
  *shallow* config merge. That is correct for top-level fields (model, mode, inputType, body,
  routes, tools, …) but **wrong** for nested `modelParams`: patching
  `{ modelParams: { temperature: 0.5 } }` shallowly would clobber `topP` / `topK` /
  `maxOutputTokens`. The sibling reducer `applyModelParamPatch(ir, nodeId, key, value)` deep-
  merges into `modelParams`, with `value === undefined` clearing a single key and an empty
  `modelParams` collapsing to *absent* (not `{}`), so it serializes the way the validator and
  goldens expect. Both reducers stay **pure** in `irReducer.ts` (no zustand reference) so the
  headless `apps/web/test/` suite continues to exercise them under `node --test` with no
  install ([ADR-0022](DECISIONS.md) reducer-purity rule). The store gains a matching typed
  action `updateModelParam(nodeId, key, value)`. Rejected alternative: generalize to a recursive
  deep-merge action — buys flexibility we don't need (no other nested-object configs in v1),
  costs precision in the action name and patch shape.
- **Instruction (and nested workflow `graph`) stay read-only.** Agent `instruction` is rendered
  read-only in this slice with a hint that the chip editor is Phase 2 — that editor needs
  Lexical + the variable-chip atom architecture ([ADR-0005](DECISIONS.md),
  [ARCHITECTURE.md §3](ARCHITECTURE.md)), which is a slice of its own. Likewise a `workflow`
  node's nested `graph` is shown as a node-count placeholder; sub-graph editing is a later slice.
  The instruction is still **rendered** in source-bound form (`<schema.field from source>` —
  [ADR-0008](DECISIONS.md)) so the user can see what the agent will receive even while editing
  is gated. This boundary keeps the slice scoped to the config surface that is one round-trip
  away from compile output, and avoids half-shipping a chip UI without the segment model.
- **Dropdowns mirror `ir.schemas`; the validator stays authoritative.** Schema-ref and type-ref
  selectors enumerate the actual declared `ir.schemas` names (plus the literal `"str"`, plus
  `null` where the field allows it; humanInput's refs intentionally omit `"str"` per the IR
  field semantics). This is the UI mirror of validator invariant 5 (every type ref resolves to
  `"str"` / `null` / a declared schema) — but enforcement still lives in `validate.ts` and
  surfaces in the Preview pane's findings list. The UI is a **narrowing** of choices, not a
  duplicate validator. Free-form text fields (model, message, body, tools, route names) stay
  free-form: the validator catches the empty/invalid cases (`AGENT_MISSING_MODEL`,
  `HUMANINPUT_MISSING_MESSAGE`, `ROUTER_ROUTE_NO_TARGET`, …) and the existing Preview surfaces
  them — no new UI validation logic.
**Headless regression oracle (`apps/web/test/irStore.test.ts`).** The three new tests widen the
spine test alongside the original `model` round-trip:
- `applyModelParamPatch` add / preserve siblings / clear one key / drop the empty field
  (deep-merge contract + purity).
- `applyNodeConfigPatch` on a function `outputType` (top-level type-ref change) — validates
  clean and reaches `functions.py`.
- `applyNodeConfigPatch` on `router.routes` — the **negative** path trips
  `ROUTER_ROUTE_NO_TARGET` + `ROUTER_EDGE_ROUTE_UNDECLARED` (invariant 7) without crashing,
  and a reordering keeps the IR clean and drives route-map entry order in `workflow.py`
  ([ADR-0014](DECISIONS.md)).
**Consequences:** A builder can now configure every v1 declarative node type end to end. The
spine extends without re-architecture (one shared reducer family, one preview, one validator).
Out-of-scope this slice: chip editor for `instruction`; canvas topology mutation (add / connect
/ delete nodes / edges); nested workflow sub-graph editing; save / load. Each lifts off the
same scaffold; none change this slice's contracts.


## ADR-0024 — Save / load IR + in-browser zip download
**Context:** [ADR-0022](DECISIONS.md) wired canvas → inspector → preview over an in-memory
fixture IR, and [ADR-0023](DECISIONS.md) opened up the inspector to every v1 node type. The
builder was usable but had no off-ramp: edits couldn't persist, and the runnable ADK project
couldn't leave the browser. This slice closes the original product loop ("download it to
further refine") by adding three actions to the existing store: Save IR (download the in-memory
`GraphIR` as `<name>.agentgraph.json`), Load IR (file-picker replaces the store IR), and
Download .zip (compile + bundle the project in-browser as `<name>.zip`). Nothing in
`packages/*` changed — codegen is frozen ([ADR-0013](DECISIONS.md), [ADR-0020](DECISIONS.md)); the
slice is a pure *consumer* of `compile` + `bundleZip`.
**Decisions:**
- **Save format = the bare IR JSON, no wrapper envelope.** The IR is the source of truth
  ([ADR-0001](DECISIONS.md)) and the canonical save/load contract; a `{ version, ir }` envelope
  would just be a second schema to evolve. `irVersion` already lives inside the IR; round-trip
  is `JSON.stringify(ir, null, 2)` ↔ `JSON.parse(text)`.
- **Load policy = parse-guard + shape-guard + load-then-surface, don't gate semantics.**
  Rejected outright: `JSON.parse` failures, non-object payloads (string / number / null /
  array), and objects missing the three array fields the canvas / inspector / preview
  iterate over (`nodes`, `edges`, `schemas`). Manual smoke caught the renderer crashing on
  `replaceIR({name:"x"})` (`Cannot read properties of undefined (reading 'map')`), which
  defeats "load-then-surface" — the user can't fix what they can't see. Accepted (load-then-
  surface): a structurally-shaped object that fails `validate` *semantically* (broken var
  refs, missing models, undeclared schemas, missing required scalar keys like `irVersion` /
  `name`). Those findings flow through the same Preview pane that already renders validation
  errors ([ADR-0022](DECISIONS.md)) plus a non-blocking banner on the toolbar showing the
  finding count. The inspector is the fix surface; gating *semantic* load behind validity
  would force the user to fix the file in a text editor before they could even see what was
  wrong. The structural guard is the minimum needed to keep React alive long enough for them
  to do that.
- **Download zip skips `format.ts` (black).** `formatProject` shells out to `python3 -m black`
  via `node:child_process` ([ADR-0020](DECISIONS.md)) and cannot run in a browser. Fragments are
  already black-shaped ([ADR-0012](DECISIONS.md)) so the emitted project is shipped unformatted-
  by-black; the round-trip test confirms byte-equality through `bundleZip` / `unzipStore`. No
  attempt to port black to WASM — that's a separate ADR if ever needed.
- **Download zip is gated on a clean IR.** `compile` throws `ValidationError` on findings
  ([packages/codegen/src/compile.ts](../packages/codegen/src/compile.ts)); the button is disabled
  while `validate(ir).errors.length > 0` so we never emit a project the validator rejects.
  Save is *not* gated — WIP is a valid thing to save.
- **Pure helper + UI shim split, same as [ADR-0022](DECISIONS.md).** All decision logic — JSON
  parsing, the load-then-surface decision, filename derivation — lives in
  [apps/web/src/store/irIO.ts](../apps/web/src/store/irIO.ts) as a React-free, zustand-free,
  DOM-free pure module exercised by `node --test` from a cold checkout (no `npm install`,
  [ADR-0011](DECISIONS.md)). The browser-only pieces — `Blob`, `URL.createObjectURL`, anchor
  click, hidden `<input type=file>` — live in
  [apps/web/src/toolbar/Toolbar.tsx](../apps/web/src/toolbar/Toolbar.tsx) as a thin un-tested
  shim. Same testability posture as `irReducer.ts` / `irStore.ts`.
- **Store gets `replaceIR(ir)` and clears the selection.** Selection is keyed by node id;
  ids from the loaded IR don't generally match the previous graph, so leaving a stale
  `selectedNodeId` in place would make the inspector edit-target undefined behaviour.
- **Codegen modules imported by their specific `.ts` path, not via
  `@graphical-agents/codegen` index.** The index re-exports `format.ts`, which top-level
  imports `node:child_process`; Vite would externalize that and explode at runtime
  ([ADR-0022](DECISIONS.md) already settled this for `compile.ts` in the Preview pane). The
  Toolbar imports `compile` from `compile.ts` and `bundleZip` from `bundle.ts` directly.
**Headless regression oracle.** Two new test files under `apps/web/test/`:
- `irIO.test.ts` — `serializeIR` ↔ `loadIRFromText` round-trips the city-time fixture clean;
  malformed JSON returns `{ok:false}` rather than throwing; non-object payloads (`42`,
  `"hello"`, `null`, `[…]`) are rejected by the shape guard; objects missing the array
  fields the renderer iterates (`nodes` / `edges` / `schemas`, or any of them not actually
  an array) are also rejected, so `replaceIR` never hands React an undefined-on-map crash
  (regression caught in the dev-server smoke); a structurally-shaped object missing
  `irVersion` / `name` still loads with `MISSING_TOP_LEVEL_KEY` findings; the
  `invalid/broken-var-and-graph.ir.json` fixture loads with var/schema/ref-class findings;
  filename helpers fall back to `graph.*` when `ir.name` is missing/empty.
- `zipRoundTrip.test.ts` — mirrors [packages/codegen/test/bundle.test.ts](../packages/codegen/test/bundle.test.ts)
  but goes through `compile` (not `generateProject` directly) so a regression in the exact
  validate → generate → bundle chain we ship to users fails the *web* suite, not just codegen's
  internal one. Six fixtures × `compile(ir)` → `bundleZip(project, ir.name)` →
  `unzipStore(bytes)` byte-equal with `ir.name/` prefix; plus a guard that `compile` throws
  `ValidationError` on the invalid fixture (the basis for the disabled download button).
The existing `irStore.test.ts` grows one case for `replaceIR` (swaps IR, clears selection).
**Consequences:** The builder is now usable end-to-end: edit visually → save → reload → load →
keep editing → download a runnable project. `apps/web` remains the only consumer of `packages/*`;
codegen stays frozen. Out of scope this slice (deliberate): localStorage autosave, multi-file
project import, draw.io, canvas topology mutation, in-browser black. Each is independent and
can lift off the same scaffold; none change this slice's contracts.

## ADR-0025 — Node palette: click-to-add, pure addNode reducer, global-namespace minting
**Context:** [ADR-0022](DECISIONS.md)/[ADR-0023](DECISIONS.md)/[ADR-0024](DECISIONS.md) wired
canvas → inspector → preview → save/load/zip, but the UI could only *edit* existing nodes.
This slice is the first to **create** IR structure: a palette of the 7 v1 declarative node
types, click to drop a fresh node into the graph. Wiring it up is the next slice; the chip
system is Phase 2. The single hard problem the slice exists to solve is **minting a unique `id`
and `name`** that hold across the entire IR including nested `workflow.config.graph` sub-graphs
(validator invariant 1, ADR-0017 flat global namespace) and produce a non-keyword Python
identifier (the codegen symbol).
**Decisions:**
- **Pure `addNode(ir, type)` reducer in [apps/web/src/store/addNode.ts](../apps/web/src/store/addNode.ts).**
  React-free, zustand-free, DOM-free — same purity split as `irReducer.ts`
  ([ADR-0022](DECISIONS.md)) so the headless test under `node --test` exercises the minter
  without `npm install`. The minter is the foundation the connect-edges slice and the Phase 2
  chip system will both reuse; keeping it out of zustand keeps the round-trip oracle live as
  those slices land. Public surface: `addNode`, `makeNodeId`, `makeNodeName`,
  `collectAllIds`, `collectAllNames`, `defaultPositionFor`.
- **Id + name scheme.** `id = n_<type>_<n>`, `name = <type>_<n>`, `n` starting at 1 and bumping
  until free against the recursively-collected namespace. `humanInput` → `human_input` for
  the name prefix (the type token isn't a valid Python identifier; the snake_case form is and
  matches the existing fixture convention). Id and name counters advance independently —
  collisions are checked against their own namespaces, never assumed paired. Rejected: short
  uuids or `cuid` — readable names beat opaque tokens for the codegen symbol the user will
  see in `agents.py` / `functions.py`, and "next free integer" is trivial to reason about.
- **Global-namespace walk.** `collectAllIds` / `collectAllNames` recurse through every
  `workflow.config.graph` so the minter respects [ADR-0017](DECISIONS.md)'s flat global
  namespace across parent + every nested sub-graph. Tested by planting a name and id INSIDE a
  nested sub-graph and asserting the minter skips past them. Node ids are not formally shared
  across sub-graphs by the validator (DUPLICATE_NODE_ID is per-graph), but the minter unifies
  the id space anyway — a single flat id space will simplify cross-graph lookups in the
  connect-edges slice without any cost.
- **Default-config-per-type table.** Each default satisfies its TS shape and every per-type
  validator rule so the only errors on a fresh add are *graph-shape* errors that disappear
  once edges are wired (next slice), not "missing field" errors:
  - `agent` — `model: "gemini-flash-latest"`, `instruction: { segments: [] }`, `mode: "task"`,
    `outputSchemaRef: "str"`, `inputSchemaRef: null` (AGENT_MISSING_MODEL needs non-empty model).
  - `function` / `tool` — `inputType: "str"`, `outputType: "str"`, `body: null` (the
    TODO-stub path).
  - `router` — `routes: ["DEFAULT"]` (ROUTER_NO_ROUTES needs ≥1 route).
  - `join` — `{ description: "" }` (no per-type checks).
  - `humanInput` — `message: "Enter input:"` (HUMANINPUT_MISSING_MESSAGE needs non-empty
    message).
  - `workflow` — `graph` = a one-node passthrough sub-IR (see next decision).
- **"Empty workflow is not valid; default sub-IR is a one-node passthrough."** A truly empty
  sub-IR fails `NO_START_EDGE` and surfaces nested findings, breaking the "fresh add ⇒
  predictable shape errors" oracle. So a fresh `workflow` node ships with one inner
  `function` + a `START → inner` edge. The inner node's name is minted against
  `parent ∪ {workflow's own name}` so the flat global namespace stays unique. Rejected:
  ship `workflow` with an explicitly-invalid empty sub-IR and rely on Preview to flag it —
  pollutes the per-type "expected fresh-add codes" set with nested findings and confuses
  later edge wiring.
- **Disconnected add ⇒ expected `UNREACHABLE_NODE` (and, for routers,
  `ROUTER_ROUTE_NO_TARGET`)** is the test oracle, not a bug. The headless test pins
  `EXPECTED_FRESH_ERROR_CODES` per type and asserts every finding is one of those codes,
  scoped to the new node id. Both codes are *graph-shape* errors that go away once edges
  land in the next slice — they are not the "missing field" pile the test exists to forbid.
  Router gets the extra code because invariant 7 ties `routes` to out-edges: with ≥1
  declared route (required) and zero edges (by design this slice), the imbalance is
  unavoidable. The Preview pane already renders findings gracefully ([ADR-0022](DECISIONS.md));
  we do not suppress.
- **Click-to-add (no drag) this slice.** Drag-to-canvas needs React Flow's drop-target API
  and a coordinate-space transform; it's a UI slice of its own and offers no additional
  test surface for the minter — which is the actual hard problem. The default `ui` position
  staggers 280px to the right of the existing graph's rightmost node so the new node doesn't
  stack on top of an existing one. Free-positioning lands when canvas drag does.
- **Palette as a 4th column** (160px) to the left of Canvas, parallel to Inspector and
  Preview — matches the existing pane rhythm and survives Phase 2 growth (variable-source
  pickers, schema palette). Rejected: inline in Canvas header (crowds canvas chrome as the
  type list grows) and a second toolbar row (a canvas action, not a project action).
**Consequences:** The minter is the cornerstone for two upcoming slices: connect-edges (will
reuse the global id/name walk to validate cross-graph references) and the Phase 2 chip system
(will mint variable references that bind a consumer to a producer by `name`). `packages/*` is
untouched; codegen and validator stay frozen ([ADR-0013](DECISIONS.md), [ADR-0020](DECISIONS.md)).
Out of scope this slice (deliberate): edge creation, delete, rename UI, drag-to-canvas, chips —
each of those is a follow-on slice that builds on the IR shape this one establishes.

## ADR-0026 — Connect plain edges + delete nodes/edges: three pure reducers, synthetic START node, router-label deferral
**Context:** [ADR-0022](DECISIONS.md)/[ADR-0023](DECISIONS.md)/[ADR-0024](DECISIONS.md)/[ADR-0025](DECISIONS.md)
took the visual builder to palette → canvas → inspector → preview → save/load/zip, but the
canvas itself was still **read-only**. A user could drop disconnected nodes from the palette and
edit their config, but could not wire them or delete anything. This slice closes that gap with
three pure IR-mutation reducers + minimal React Flow wiring so the canvas becomes a true editor.
**Decisions:**
- **Three pure reducers in `apps/web/src/store/irEdges.ts`** — joins
  [`irReducer.ts`](../apps/web/src/store/irReducer.ts) and
  [`addNode.ts`](../apps/web/src/store/addNode.ts) as the third pure-reducer module, React-free /
  zustand-free / DOM-free, exercised under `node --test` from a cold checkout
  ([ADR-0011](DECISIONS.md) / [ADR-0022](DECISIONS.md) purity rule):
  - `connectEdge(ir, fromId, toId)` appends `{from, to}` with no `route` label this slice.
    `fromId` may be the literal `"START"`. Silent **no-op (returns the input IR reference)** on:
    `toId === "START"` (IR-SCHEMA invariant 2 — START is reserved as an edge `from` only),
    `fromId === toId` (self-loop — not a meaningful edit), and exact duplicate of an existing
    edge (same `from`/`to`/`route`). The reducer deliberately does **not** re-implement
    validation — no cycle check, no reachability check, no DAG check. The validator owns the IR
    spec ([ADR-0001](DECISIONS.md) / [ADR-0013](DECISIONS.md)) and the Preview pane already
    surfaces findings without crashing; duplicating that logic in the reducer would split the
    source of truth.
  - `deleteNode(ir, nodeId)` removes the node AND every edge that references it (as `from` or
    `to`) — a cascade, not a dangling-edge leak. Operates on the **top-level graph only**: if
    `nodeId` is not a top-level node (e.g. lives inside `workflow.config.graph`), the reducer
    returns the input IR reference. Nested-graph topology editing is a focused follow-up slice.
  - `deleteEdge(ir, fromId, toId)` removes every edge matching `{from, to}` (route-agnostic — a
    click-delete on a router branch edge removes it regardless of label). No-op (same IR ref)
    if no edge matches.
  - All three reducers are pure: existing array elements stay referentially equal where
    unchanged, and the no-op branches return the exact input ref so the React store wrapper can
    short-circuit without re-rendering.
- **Selection-clear-on-delete is a store concern, not a reducer concern.** The `deleteNode`
  reducer stays pure; `useIRStore.deleteNode` is the wrapper that additionally clears
  `selectedNodeId` when it matched the removed node. Same purity boundary as
  [ADR-0022](DECISIONS.md): React-free reducers below, zustand glue above.
- **START is represented as a synthetic, non-deletable canvas node** with id `"START"` and
  `type: "ir-start"`, prepended when mapping `ir.nodes` → React Flow nodes. It is **not** in
  `ir.nodes`. Materializing START on the canvas lets React Flow's `onConnect` return
  `source: "START"` naturally when the user drags from it, so the reducer signature stays a
  symmetric `(fromId, toId)` pair instead of a special-case "connect from START" action. The
  synthetic node is marked `deletable: false` / `selectable: false` / `draggable: false`, so
  the delete-key path can't remove it and `setSelectedNode` ignores clicks on it. This drops
  the previous Canvas.tsx "filter out START edges" hack — every IR edge is now a real RF edge.
- **Store-not-React-Flow owns the edges.** The canvas does **not** adopt React Flow's
  `useNodesState` / `useEdgesState`; that would create a parallel mutable copy and split the
  source of truth. Instead, every render derives RF nodes + edges from the IR store, and the
  `onConnect` / `onNodesDelete` / `onEdgesDelete` callbacks dispatch reducer actions. The IR
  remains the single source of truth ([ADR-0001](DECISIONS.md)), and the canvas re-derives
  from the new IR on each store update.
- **Selection bridge — `onNodesChange` / `onEdgesChange` for `select` events only.** React
  Flow's keyboard Delete handler reads from RF's internal selection store, which in
  controlled mode only learns about clicks through `onNodesChange` / `onEdgesChange`. To
  make Delete actually fire `onNodesDelete` / `onEdgesDelete`, the canvas wires both change
  callbacks, filters to `change.type === "select"`, and updates our store (`setSelectedNode`
  for nodes; local `selectedEdgeId` state for edges — the IR doesn't model edge selection).
  All other change kinds (position, dimensions, add, remove) are ignored: nodes aren't
  draggable this slice, and topology mutations flow through `onConnect` / `onNodesDelete` /
  `onEdgesDelete` against the IR. The `selected` flag is set at the RF-node top level (not
  inside `data`) on each render so RF picks it up — `data.selected` is kept for our own
  `IRNode` visual feedback.
- **Dev-only `globalThis.__ga_useIRStore` hook for manual verification.** Gated behind
  `import.meta.env.DEV` so production builds drop it. Exists because the chrome-devtools
  MCP's synthesized keydowns don't reach React Flow's keyboard listener, so the manual
  in-browser verification step needs a direct route to dispatch reducer actions and read
  back the resulting IR. A real user with focus on the canvas hits the Delete-key path
  via React Flow's listener normally; the hook is only for the headless browser harness.
- **Router-label deferral, with the `ROUTER_UNLABELED_EDGE`-is-honest rationale.** Router
  branch edges need a `route` label (IR invariant 7 — declared `routes` ⇔ out-edge `route`
  labels). The UI for picking the label at connect-time is its own focused slice; it needs an
  edge-creation flow that knows which source is a router and surfaces the declared routes.
  This slice **does not** special-case wires out of a router — they are created as plain
  (unlabeled) edges, exactly like wires out of an agent or function. The existing Preview
  surfaces the resulting `ROUTER_UNLABELED_EDGE` validator finding. That is correct, honest
  behavior — the validator already says exactly the right thing — and the right time to silence
  the finding is when the route-label UI lands, not by hiding it in the reducer.
- **Headless regression oracle, no new fixture.** [`apps/web/test/irEdges.test.ts`](../apps/web/test/irEdges.test.ts)
  pins the contracts above against `city-time.ir.json` and `nested.ir.json`:
  - `connectEdge` happy path — drop the city-time `n_lookup → n_report` edge, assert
    `UNREACHABLE_NODE`, wire it back, assert `validate` clean and `compile()` reflects the new
    chain in `workflow.py`. The chosen edge gives the strongest one-line oracle:
    `UNREACHABLE_NODE` before, validates after, mentions both `lookup_time` and `city_report`
    in `workflow.py`.
  - `connectEdge` guards — edge-to-START, duplicate (including double-call on a freshly-added
    pair), and self-loop each return the same IR reference.
  - `deleteNode` cascade — using `n_lookup` (has both an in-edge and an out-edge) asserts both
    edges vanish and no remaining edge references the deleted id.
  - `deleteNode` nested no-op — calling on `n_inner_a` (an id that lives only inside
    `nested.ir.json`'s sub-graph) returns the input IR reference.
  - `deleteEdge` exact — removes only the target pair; non-existent pair returns the input ref.
  - Purity — all three reducers leave the input arrays untouched and preserve sibling node
    identity in the result.
- **`packages/*` unchanged.** No new validator codes, no new edges-compiler rules, no new
  codegen behavior; codegen and validator stay frozen ([ADR-0013](DECISIONS.md),
  [ADR-0020](DECISIONS.md)). The slice is pure UI surface plus a new reducer module.
**Consequences:** The canvas becomes a true editor: palette nodes can be wired in any order,
mistakes are recoverable via delete + reconnect, and Preview's findings list narrates the
graph-shape consequences in real time. The three reducers join the chip system's
forthcoming dependency-edge code as the foundation for Phase 2's variable-source binding
(a chip drop will mint a data-dependency edge through the same store action discipline).
**Out of scope this slice (deliberate):** router `route` labels at connect-time, nested
`workflow.config.graph` topology editing, edge reconnection / drag-to-move endpoint (delete +
recreate is fine), undo/redo, node position editing. Each is independent and lifts off the
scaffold this slice establishes; none change its contracts.

## ADR-0027 — Router route-label editing: connect-with-default-route, `setEdgeRoute`, store-side edge selection, dropdown mirrors `router.config.routes`
**Context:** [ADR-0026](DECISIONS.md) deliberately deferred router edge labels: a wire out of a
`router` was created unlabeled, and the validator's invariant-7 `ROUTER_UNLABELED_EDGE` finding
flowed through Preview as the honest signal. That is correct for one slice, but it leaves the
visual builder unable to produce a valid branching graph — even though the IR + validator +
codegen have supported route maps end-to-end since [ADR-0014](DECISIONS.md). This slice gives
the UI the ability to **write and edit** `edge.route`. `packages/*` is unchanged.
**Decisions:**
- **Extended `connectEdge(ir, fromId, toId, route?)` rather than a sibling `connectRouterEdge`.**
  One signature keeps the duplicate rule in one place and matches how the canvas already calls
  a single reducer. The optional fourth arg is `undefined` for non-router connects (existing
  call sites unaffected). Pure reducer in
  [apps/web/src/store/irEdges.ts](../apps/web/src/store/irEdges.ts), exercised under `node --test`
  with no install ([ADR-0011](DECISIONS.md) / [ADR-0026](DECISIONS.md) purity rule).
- **Duplicate rule = exact `(from, to, route)` match.** Same router → same target → same route is
  a no-op (returns the input IR ref). Same router → same target → *different* declared routes is
  **allowed** — the ADK route map shape `{"A": target, "B": target}` is legitimate. The
  ADR-0026 rule (plain edges deduplicate on `(from, to)` with both `route` undefined) is the
  special case of this generalized rule where both routes are undefined.
- **`setEdgeRoute(ir, fromId, toId, oldRoute, newRoute)` is the relabel operation.**
  Identifying by the `(from, to, oldRoute)` triple is required because a single router can have
  several out-edges to *different* targets and (per the duplicate decision above) to the *same*
  target under different routes. No-op (input IR ref) if no edge matches. The replacement
  preserves array position so unrelated edges keep their identity for downstream memoization.
- **Connect UX: default to the router's first declared route.** When `onConnect` fires with a
  router as source, the canvas looks up the source node and passes `config.routes[0]` as the
  fourth arg. The resulting edge satisfies invariant 7 *immediately* (the route is declared, the
  target exists) so the IR stays valid through the drag — no blocking modal mid-gesture. The
  user can fix it via the Inspector edge-form dropdown in two clicks. If the router has zero
  declared routes (the validator is already screaming `ROUTER_NO_ROUTES`), `route` is left
  undefined and `ROUTER_UNLABELED_EDGE` surfaces honestly — same posture as
  [ADR-0026](DECISIONS.md)'s deferred-router rationale. Rejected: route-picker popover on
  connect (overbuild for the slice; the default + dropdown is two clicks max and avoids a
  modal-during-drag UX).
- **Edge selection lifted into the store as `selectedEdge: { from, to, route? } | null`.**
  ADR-0026 kept `selectedEdgeId` as Canvas-local state because only React Flow's Delete handler
  needed it. The route dropdown needs *the Inspector* to read the selected edge, so the
  selection moves into [irStore.ts](../apps/web/src/store/irStore.ts) alongside `selectedNodeId`
  with `setSelectedEdge`. The triple (not the RF edge id string) is what gets stored because
  two router edges may share `(from, to)` under distinct routes. Node and edge selection are
  *mutually exclusive when one is set*: setting a non-null node clears the edge and vice
  versa; setting either to null leaves the other alone. Pane click clears both.
- **`setEdgeRoute` store wrapper updates the selection in lockstep.** When the user relabels the
  currently-selected edge, the wrapper rewrites `selectedEdge.route` to `newRoute` so the
  dropdown's `value` follows the change without the user re-clicking the edge. The pure reducer
  doesn't know about selection (ADR-0026 reducer-purity rule); the store glue owns it.
- **Inspector dispatches `selectedEdge` to a new `EdgeForm` before the node form.** When the
  source is a router, the form renders a `<select>` whose options come from that router's
  `config.routes` — same mirror-the-IR posture as the schema-ref dropdowns
  ([ADR-0023](DECISIONS.md)). When the source is not a router, the form is a read-only
  "plain edge" hint; this slice only edits router routes. The dropdown shows the edge's
  *current* route as a synthetic option when it isn't in the declared list (e.g. after the
  router's `routes` was edited downstream) so the value stays visible while Preview surfaces
  the `ROUTER_EDGE_ROUTE_UNDECLARED` finding. Validation is **not** re-implemented in the
  Inspector — the validator owns invariant 7 and Preview is the one place findings surface.
- **`packages/*` unchanged.** No new validator codes, no new edges-compiler rules, no codegen
  behavior change; codegen and validator stay frozen ([ADR-0013](DECISIONS.md),
  [ADR-0020](DECISIONS.md)). The slice is pure UI surface plus a new reducer (`setEdgeRoute`)
  and a generalized `connectEdge`.
**Headless regression oracle.** New tests in
[apps/web/test/irEdges.test.ts](../apps/web/test/irEdges.test.ts):
- `connectEdge` with route rewires `routing.ir.json` from scratch: strip the three branch
  edges, reattach each `(router → target, route)`, assert `validate` clean and the
  `(router, {route: target})` row appears in `workflow.py` with all three declared routes and
  branch-target symbols.
- `setEdgeRoute` precisely relabels one of three out-edges from `n_router`: the BUG edge
  becomes CUSTOMER_SUPPORT; the SUPPORT and LOGISTICS edges keep their labels; the resulting
  invariant-7 imbalance (`ROUTER_ROUTE_NO_TARGET: BUG`) surfaces as a validator finding —
  proving the reducer mutates only the one edge and the validator catches the consequences.
- `setEdgeRoute` no-op (returns input IR ref) when the `(from, to, oldRoute)` triple does not
  match any edge.
- Duplicate-route guard vs. distinct-route-same-target: same `(router, target, "BUG")` twice
  is a no-op; same `(router, target)` with `"BUG"` then `"CUSTOMER_SUPPORT"` adds a second
  edge (ADK route maps are fine with that).
- `routing.ir.json` round-trip: loads clean, compiles to the route-map row mentioning all
  three routes and all three branch-target symbols.
The existing ADR-0026 tests still pass unchanged — the duplicate guard for the plain-edge
case is the both-`undefined` special case of the generalized rule.
**Manual verification (in `apps/web && npm run dev`):**
1. Load IR → `packages/ir/fixtures/routing.ir.json`. Preview is clean; `workflow.py` shows
   `(router, {"BUG": handle_bug, "CUSTOMER_SUPPORT": handle_customer_support, "LOGISTICS": handle_logistics})`.
2. Click one of the three branch edges → Inspector shows `router → handle_bug` with a route
   dropdown populated from `["BUG", "CUSTOMER_SUPPORT", "LOGISTICS"]`.
3. Relabel BUG → CUSTOMER_SUPPORT. Canvas label updates immediately; Preview now shows the
   invariant-7 finding `ROUTER_ROUTE_NO_TARGET: BUG`. Relabel back to BUG → findings clear.
4. From-scratch: Add Router (palette) → set `routes` in Inspector to `["BUG", "SUPPORT"]` →
   Add two Agents → drag router→agent twice. The first edge gets `route: "BUG"` by default;
   relabel the second to `SUPPORT` via the dropdown. Preview's `workflow.py` reflects the
   two-route map. Findings clear once both declared routes are wired.
**Out of scope this slice (deliberate):** nested-graph topology editing (lives in
`workflow.config.graph` — a follow-on slice), edge endpoint-drag reconnection (delete +
recreate works), drag-to-canvas, undo/redo, route-label chip rendering inside the canvas
beyond React Flow's default label. Each is independent and none changes this slice's
contracts.
**Consequences:** With this slice the visual builder can produce *every* v1 declarative
construct end to end — including a valid branching graph that compiles directly to ADK's
route-map row form. The deferred-router rationale in [ADR-0026](DECISIONS.md) is now closed:
`ROUTER_UNLABELED_EDGE` will only fire from the zero-declared-routes edge case, not from
ordinary user gestures.

## ADR-0028 — Node drag: pure `applyNodePosition`, RF `position` events committed every tick
**Context:** [ADR-0025](DECISIONS.md) deferred free-positioning ("lands when canvas drag does")
and [ADR-0026](DECISIONS.md) kept `nodesDraggable={false}`. Once
[ADR-0027](DECISIONS.md) made branching graphs buildable from scratch, the missing drag became
the *visible* gap: `addNode` staggers new nodes 280px to the right of the rightmost existing
node, so a router + two branch agents end up collinear and the connect gesture has nowhere to
land cleanly. This slice flips on dragging and persists positions through the IR.
**Decisions:**
- **Pure `applyNodePosition(ir, nodeId, x, y): GraphIR`** in
  [irReducer.ts](../apps/web/src/store/irReducer.ts) — the fourth pure reducer alongside
  `applyNodeConfigPatch`, `applyModelParamPatch`, and the topology reducers. Writes
  `node.ui.{x,y}`. **No-op (returns the input IR ref)** when the node isn't found OR the
  position is byte-equal to the existing one, so RF's idle re-renders (which can emit
  zero-delta `position` events as the layout settles) don't churn the store or trigger
  re-renders. Same purity rule as the other reducers (ADR-0011 / ADR-0022).
- **Sibling identity preserved.** The reducer only rebuilds the moved node; the other entries
  in `nodes` keep referential identity. RF's `useMemo` on `rfNodes` then keeps unaffected
  React Flow nodes identity-equal, so only the dragged node re-renders. Headless test pins
  this — it's the gate against a "naive map(...)" regression that would tank drag perf as
  graph size grows.
- **Canvas commits every `position` change, not just `dragging: false`.** ADR-0026's
  "store-not-RF-owns-edges" rule means React Flow renders in controlled mode from
  `rfNodes` derived from `ir.nodes`. If we only committed on drag-end, RF's controlled
  position would snap back to the IR's old `ui.{x,y}` on the next render and the drag would
  be visually frozen. So `onNodesChange`'s `position` branch dispatches `setNodePosition`
  on every tick. The reducer's "unchanged → input ref" guard means we don't churn during the
  zero-delta events RF emits around drag start/end.
- **START stays undraggable.** The synthetic START node is `draggable: false` already
  (ADR-0026 synthetic-node decisions), and the Canvas's `position` branch skips
  `START_NODE_ID` defensively so a manual dispatch can't move it either. Its position is
  derived dynamically from the leftmost real node's `ui` (`startNodePosition` in Canvas) and
  shouldn't live in the IR — START isn't an IR node.
- **No store-side debounce, no batching.** Zustand's `set` is synchronous, the reducer is
  pure, and React 19 batches renders across the synchronous event loop tick — so the
  per-tick dispatch is cheap enough that adding RAF / requestIdleCallback would be a
  premature optimization. Revisit if a large graph (100+ nodes) ever drags choppily.
- **Save IR round-trips positions.** `node.ui` was already part of the IR JSON schema and
  `serializeIR` / `loadIRFromText` ([ADR-0024](DECISIONS.md)) handle it generically; no
  change needed. The headless test confirms a `JSON.stringify` ↔ `JSON.parse` cycle preserves
  positions written by `setNodePosition`, so a saved IR re-opens with the user's layout
  intact.
- **`packages/*` unchanged.** No validator codes, no codegen behavior. `node.ui` is metadata
  the validator already accepts.
**Headless regression oracle.** Four new tests in
[apps/web/test/irStore.test.ts](../apps/web/test/irStore.test.ts):
- `applyNodePosition` writes `ui.{x,y}` and preserves sibling identity.
- `applyNodePosition` returns the input IR ref when the position is unchanged.
- `applyNodePosition` no-ops on unknown nodeId.
- `store.setNodePosition` persists into the IR and a serialize → parse round-trip preserves
  the moved position (Save IR contract).
**Manual verification (in `apps/web && npm run dev`):**
1. Drag any node on the canvas — it follows the cursor smoothly.
2. Save IR → reload → Load IR; the node is at the new position.
3. Add Router (palette) → Add Agent → Add Agent. The default stagger lines them up
   collinearly; drag each agent to a distinct y to give the connect gesture room. Drag
   from the router's source handle to each agent — both connections succeed with the
   default `BUG` route from ADR-0027.
**Out of scope this slice (deliberate):** drag-to-add (palette → drop on canvas), auto-layout
("clean up positions"), multi-select drag, snap-to-grid, undo/redo for position changes. Each
lifts off this scaffold; none change its contracts.
**Consequences:** With this slice the canvas is a genuine 2D editor. The original ADR-0025
deferral ("free-positioning lands when canvas drag does") is closed. ADR-0027's "drag from
router to each agent" manual step is now physically possible from the UI without
`globalThis.__ga_useIRStore` shenanigans.

## ADR-0029 — Phase 2a: editable agent prompt via Lexical + a pure segments↔editor-state bridge
**Context:** Until this slice an agent's `instruction` was rendered **read-only** as a
`<pre>` of `<schema.field from source>` in the inspector
([apps/web/src/inspector/Inspector.tsx](../apps/web/src/inspector/Inspector.tsx) `AgentForm`).
The IR already carried the structured `InstructionTemplate { segments }` model
([packages/ir/src/types.ts](../packages/ir/src/types.ts)) and codegen + validator both spoke
it ([ADR-0008](DECISIONS.md), invariant 6 in `validate.ts`), so the missing piece was a UI
that *produced* segments. [docs/PHASE-2-DESIGN.md](PHASE-2-DESIGN.md) splits Phase 2 into
**2a** (editable prompt, no new IR mutations) and **2b** (field insertion + the
`inputSchemaRef` auto-wire). This ADR records 2a: a Lexical editor over the existing
segment model, deliberately with **no insertion, no `inputSchemaRef` mutation, no schema
authoring**. `packages/*` is frozen — no validator codes, no codegen changes.
**Decision:**
- **Segments ↔ Lexical = two PURE functions over plain JSON
  ([apps/web/src/inspector/segmentsBridge.ts](../apps/web/src/inspector/segmentsBridge.ts)).**
  This is the [ADR-0022](DECISIONS.md) reducer posture applied to the editor:
  `segmentsToEditorState(segments)` and `editorStateToSegments(state)` operate on plain
  object literals matching what `VariableNode.exportJSON()` emits. **The bridge must
  not `import "lexical"`** — every existing `apps/web/test/*.test.ts` runs under
  `node --test` with **no `npm install`** ([ADR-0011](DECISIONS.md) /
  [ADR-0013](DECISIONS.md) cold-checkout posture), and the bridge joins
  `irReducer`/`addNode`/`irEdges` in that install-free reducer family. The bridge is
  what the headless round-trip oracle pins; the React shell is a thin consumer.
  Rejected alternative: build editor nodes via Lexical's `$create*` helpers inside the
  React component. That would push the round-trip logic into a `lexical`-importing
  module and break the cold-checkout test gate.
- **Chips are `VariableNode extends TextNode` in `"token"` mode**
  ([apps/web/src/inspector/VariableNode.ts](../apps/web/src/inspector/VariableNode.ts)).
  Token mode is Lexical's atomic-text mode — caret can't enter, one backspace deletes
  the whole chip — and the Lexical "mentions" example uses the same pattern. The chip
  carries `{schema, field, source}` in serialized state and overrides `getType()` to
  `"variable"` so `super.exportJSON()` tags the node correctly. The pinned chip-JSON
  shape (the test snapshot in
  [apps/web/test/segmentsBridge.test.ts](../apps/web/test/segmentsBridge.test.ts)) is
  the contract between the bridge and `VariableNode.exportJSON` — if a future Lexical
  upgrade changes the required base shape, that snapshot fails loud and we update both
  ends in lockstep. Rejected alternative: `DecoratorNode`. Heavier (a sub-React tree),
  block-ish (less natural for inline atomic chips), and not what the mentions example
  picked.
- **Seed once per node via `key={node.id}` — IR is *never* pulled back into the editor
  mid-edit.** The editor is the local authority while editing one agent; on change it
  serializes via `OnChangePlugin → editorStateToSegments → onChange` and dispatches
  one `updateNodeConfig(node.id, { instruction: { segments } })`. If the editor
  re-seeded from the IR on every store update, we'd get the
  `onChange → updateNodeConfig → re-render → re-seed → onChange` caret-fight feedback
  loop — exactly the [ADR-0026](DECISIONS.md) "React-Flow-owns-edges" trap echoed for
  contenteditable. `AgentForm` remounts `<VariableEditor>` with `key={node.id}` so a
  fresh `initialConfig.editorState` runs once per agent (Lexical reads `editorState`
  once at mount); within a node, no re-seed.
- **PlainTextPlugin + `LineBreakNode`s for `\n`.** Newlines round-trip as line breaks
  *within* a single paragraph — `text "a\nb"` → `[text "a", linebreak, text "b"]` →
  back to `text "a\nb"`. RichTextPlugin would split on Enter into separate paragraphs;
  the bridge defensively coalesces multi-paragraph state too, but the single-paragraph
  posture avoids the ambiguity and keeps the editor scoped to what an agent
  instruction actually needs.
- **No `inputSchemaRef` touch, no insertion, no DnD, no schema authoring, no undo/redo.**
  Every one of those is owned by a later slice (2b for insertion + auto-wire; future
  slices for schema authoring). The point of 2a is the editable round-trip itself —
  scope discipline keeps the slice to one hard problem.
- **`packages/*` frozen.** No new validator codes; invariant 6 still lives in
  `validate.ts` and surfaces in the Preview pane unchanged. Codegen golden files are
  untouched (`renderInstruction` already consumes the segment model). `apps/web` is
  the only `npm install` boundary; `lexical` + `@lexical/react` are added there.
**Headless regression oracle
([apps/web/test/segmentsBridge.test.ts](../apps/web/test/segmentsBridge.test.ts)).**
Seven tests pin the bridge as the spec:
- City-time report agent fixture: `segments → state → segments` is identity (chip +
  text + chip interleaving + an embedded `\n`).
- A multi-line text segment round-trips its `\n` characters.
- Empty prompt: `segments: []` → an editor state with one empty paragraph (so
  Lexical mounts cleanly) → back to `[]`.
- Hand-written `[var, text, var]` round-trips losslessly (chip at start and end).
- Adjacent text segments coalesce on the way out (documented behavior).
- **Pinned chip-JSON shape:** literal snapshot of the `variable`-node shape (`type`,
  `mode: "token"`, `schema`, `field`, `source`, `text` matching the source-bound
  form). Fails loud if a Lexical upgrade silently changes the base.
- Unknown editor-state node types are skipped, not crashed (forward-compat).
Plus an integration check in
[apps/web/test/irStore.test.ts](../apps/web/test/irStore.test.ts): after a
`updateNodeConfig(n_report, { instruction: <round-tripped segments> })`,
`validate(ir).ok` and `compile(ir).get("agents.py")` still contains both source-bound
chips. Proves the bridge produces segments codegen can consume unchanged.
**Manual verification (`apps/web && npm install && npm run dev`):**
1. Load the city-time fixture, click `city_report` → the Inspector renders an
   editable Lexical editor instead of the `<pre>`. Existing chips appear as inline
   pills.
2. Type plain text before/after a chip → Preview's `agents.py` `instruction=` string
   updates live.
3. Backspace once over a chip → the entire chip disappears in one keystroke
   (token-mode contract); Preview reflects the new segments.
4. Switch to `city_generator` → editor remounts with that agent's segments (seed
   once per node).
5. Save IR → Load IR round-trips the edited segments.
**Consequences:** The headline variable-chip system is now half-shipped — agents have
an editable prompt that round-trips chips losslessly, and the bridge is the
install-free oracle future slices build against. **2b (next)** adds the insert palette,
the single `inputSchemaRef` auto-mutation, and the single-schema rail — all on top of
this bridge, with no further IR contract changes. Schema/field authoring, auto-edge
inference from chip insertion, and non-adjacent (session-`state`) variables remain
explicitly deferred (PHASE-2-DESIGN decisions 6 / 7, ARCHITECTURE roadmap Phase 3).

## ADR-0030 — Phase 2b: insert variable chip + auto-wire `inputSchemaRef`
**Context:** [ADR-0029](DECISIONS.md) shipped 2a — the agent prompt is editable and
round-trips existing chips through the install-free `segmentsBridge.ts`, but the
user had no way to *produce* a new `VarSegment`. The IR already carried the full
variable contract (invariant 6 in
[packages/ir/src/validate.ts](../packages/ir/src/validate.ts); codegen emits the
source-bound form via `renderInstruction` in
[packages/codegen/src/fragments.ts](../packages/codegen/src/fragments.ts)); the only
missing piece was the UI that *yields* well-formed chips and auto-wires the
companion `inputSchemaRef`. [docs/PHASE-2-DESIGN.md](PHASE-2-DESIGN.md) reserved
this for slice 2b and pinned the design's spine: because invariant-6 clause (d)
forces `inputSchemaRef` to equal every chip's `schema`, an agent can reference
variables from exactly one schema — that fact becomes the **single-schema rail**
in the palette UX. This ADR records 2b: the insert palette, the click-to-insert
caret flow, the single `inputSchemaRef` auto-mutation, and the not-upstream
advisory. `packages/*` stays frozen — no new validator codes, no codegen changes.
**Decision:**
- **Pure helper `insertVariable(ir, agentId, ref): GraphIR`
  ([apps/web/src/store/insertVariable.ts](../apps/web/src/store/insertVariable.ts)).**
  Appends a `VarSegment` to the agent's `instruction.segments` AND sets
  `agent.config.inputSchemaRef = ref.schema` when not already equal — one
  immutable patch, sibling node identity preserved. Joins the install-free
  reducer family alongside `irReducer.ts` / `addNode.ts` / `irEdges.ts`
  (ADR-0011 / ADR-0013 / ADR-0022 posture). The same module also exports the
  palette's pure candidate logic — `candidateVariables`, `chipSchemas`,
  `upstreamProducers` — so the React shell stays trivial and the rules are
  pinned by headless tests. Rejected alternative: drive insertion through the
  existing `updateNodeConfig` reducer with two separate dispatches at the
  helper layer. That spreads the "what does insertion mean?" semantic across
  caller sites; collapsing it into one helper gives 2b a single oracle the
  tests can pin.
- **`inputSchemaRef` is the only auto-mutation.** No schema authoring, no
  auto-edge creation, no chip-rewriting, no non-adjacent-variable (session-
  `state`) support. PHASE-2-DESIGN decision 4 explicitly bounds the slice
  here; widening it would require a chip-rewrite story we don't have yet
  (e.g. what happens to existing CityTime chips if a user inserts a Foo
  chip? — we sidestep via the single-schema rail). The helper's
  no-op-when-equal short-circuit also keeps the inspector dropdown from
  seeing a spurious change event on every chip insert.
- **Single-schema rail in the palette
  ([apps/web/src/inspector/VariablePalette.tsx](../apps/web/src/inspector/VariablePalette.tsx)).**
  Keys off the schema(s) of *existing chips* on the agent — not
  `inputSchemaRef`. PHASE-2-DESIGN decision 5 calls out the deliberate
  corner: an agent with `inputSchemaRef` set but no chips is offered all
  candidate schemas (the rail is about "preserve what you've already
  inserted," not "advertise the declared input"). The rail is enforced in
  `candidateVariables` so the UI is a pure render of the helper's output
  — easy to test, hard to mis-style.
- **Advisory, not validator code.** When the chosen `source` is not in the
  agent's upstream set (computed by `upstreamProducers` via reverse-BFS on
  `ir.edges`), the palette button gains a ⚠ marker and an `:hover` title
  warning. Insertion still works; codegen still emits the chip. PHASE-2-
  DESIGN decision 7 explicitly chose this over adding a new validator code
  — that would touch frozen `packages/*` and conflate "didn't wire the
  edge" (a graph topology gap) with "chip is malformed" (an IR contract
  violation). v1 accepts the gap, flagged in the UI. Rejected alternative:
  silently auto-create the `source → agent` edge on insert. That mutates
  graph topology from a prompt edit — surprising, and breaks the "one
  focused mutation per action" posture above.
- **Selection-capture in `InsertVariablePlugin`
  ([apps/web/src/inspector/VariableEditor.tsx](../apps/web/src/inspector/VariableEditor.tsx)).**
  PHASE-2-DESIGN trap: a palette-button click moves focus out of the
  `contenteditable`, so "insert at caret" has no caret by the time the
  handler runs. Fix: an inner Lexical plugin (must live inside
  `<LexicalComposer>` to use `useLexicalComposerContext`) registers a
  `SELECTION_CHANGE_COMMAND` listener and snapshots the last `RangeSelection`
  via `selection.clone()`. The exposed `insertVariable(ref)` method runs
  `editor.update(() => { $setSelection(saved.clone()); $insertNodes([...]) })`,
  falling back to `$getRoot().selectEnd()` if no selection was ever
  captured (e.g. user clicks the palette without ever focusing the
  editor). The plugin populates a parent-owned `apiRef` so `AgentForm`
  (which holds the palette) can drive the editor imperatively — a
  forwarded ref is the bridge between two siblings inside the same
  Composer. ADR-0029's "seed once per node" invariant still holds:
  insertion is via `editor.update` + `$insertNodes`, not a re-seed of
  `initialConfig.editorState`.
- **Two-dispatch UI flow, one user-perceived action.** The palette click
  handler does (1) `editorApiRef.current?.insertVariable(ref)` — the
  editor's `OnChangePlugin` fires synchronously, runs the existing
  `editorStateToSegments` path, and dispatches
  `updateNodeConfig({instruction})`; then (2)
  `updateNodeConfig({inputSchemaRef: ref.schema})` — skipped when already
  equal. Two zustand updates, but they collapse into one user-perceived
  change because React batches the resulting renders. Rejected alternative:
  drive both via a single `store.insertVariable(agentId, ref)` action that
  reads the editor's *output* segments. That couples the store to the
  editor's serialization timing and duplicates the helper's append
  semantic — the current shape uses the editor as the position oracle
  (caret-aware) and the helper as the IR-semantic oracle (headless-
  tested), without overlapping responsibilities.
- **DnD deferred within 2b.** PHASE-2-DESIGN decision (slice plan)
  reserved DnD as an enhancement that may be deferred if caret-placement
  proves flaky. Click-to-insert is the primary, reliable path and ships
  here; DnD lands later if needed. The `VariableEditorAPI` is the
  extension point — a future DnD handler can call the same
  `insertVariable(ref)` after computing the caret from the drop event.
- **`packages/*` frozen.** No new validator codes; invariant 6 still owns
  the IR spec and surfaces in the Preview pane. Codegen goldens are
  untouched. `apps/web` is the only `npm install` boundary; no new
  dependencies beyond what 2a added.
**Headless regression oracle.** Two new test files under
[apps/web/test/](../apps/web/test/), both running install-free under
`node --test`:
- [insertVariable.test.ts](../apps/web/test/insertVariable.test.ts) — six
  tests pin the pure helper:
  1. Sensible case: insert `CityTime.time_info` into a chip-free
     `n_report` → `validate(next).ok === true` and
     `compile(next).get("agents.py")` includes
     `<CityTime.time_info from lookup_time>`.
  2. Auto-wires `inputSchemaRef` from `null` → `"CityTime"`.
  3. Leaves `inputSchemaRef` alone when already equal (no spurious
     mutation).
  4. Purity: original IR + sibling nodes preserve referential identity.
  5. Unknown `agentId` is a no-op (returns input IR ref).
  6. Non-agent target (a function node id) is a no-op.
- [insertVariable.candidates.test.ts](../apps/web/test/insertVariable.candidates.test.ts)
  — four tests pin the palette logic:
  1. Single-schema rail blocks a second schema once any chip is locked
     (synthetic `Foo`-producing function added on top of city-time).
  2. No chips ⇒ all structured candidates offered (rail disengaged).
  3. Excludes `"str"` / `null` producers and the consuming agent itself.
  4. `upstreamProducers` walks reverse `ir.edges`; with the producer →
     agent edge removed, every candidate is flagged `isUpstream: false`
     (drives the UI advisory).
**Manual verification (`apps/web && npm install && npm run dev`):**
1. Load the city-time fixture, click `city_report` → the Variable Palette
   appears below the instruction editor, listing `lookup_time.city` and
   `lookup_time.time_info` (CityTime — the single-schema rail is engaged
   because chips already exist).
2. Place the caret inside the prompt between two text runs, click a
   palette button → chip lands at the caret; Preview's `agents.py`
   `instruction=` updates with the new source-bound string.
3. Clear chips manually, dropdown-set `inputSchemaRef` to `null`, insert a
   CityTime field → `inputSchemaRef` flips back to `"CityTime"` in the
   inspector dropdown and Preview validates clean.
4. Click a palette button without first focusing the editor → chip
   appends at the end of the prompt (the `selectEnd()` fallback).
5. Delete the `lookup_time → city_report` edge in the canvas → palette
   buttons get a ⚠ marker; insertion still works; validator stays silent
   (advisory only — deliberate per design decision 7).
**Consequences:** Phase 2 ships end-to-end — the headline variable-chip
system is now reachable from the UI with one focused auto-mutation.
DnD is the only enhancement left within Phase 2's scope. Schema/field
authoring, auto-edge inference from chip insertion, and non-adjacent
(session-`state`) variables remain explicitly deferred (PHASE-2-DESIGN
decisions 6 / 7, ARCHITECTURE roadmap Phase 3). Draw.io import (Phase 3)
is then the last major v1 piece.

## ADR-0031 — Two-tier testing: install-required `test:web:dom` covers the Lexical layer; first test is the `907dea2` regression
**Context:** The install-free cold-checkout posture ([ADR-0011](DECISIONS.md) /
[ADR-0013](DECISIONS.md)) is what lets `git clone && npm test` go green
without `npm install`. It works because every existing test file imports
only IR types, Node builtins, and pure reducer / bridge modules — none of
the `lexical`-importing surface. The deliberate consequence
([ADR-0029](DECISIONS.md) decision 2 — "the bridge must NOT
`import \"lexical\"`") was that
[apps/web/src/inspector/VariableNode.ts](../apps/web/src/inspector/VariableNode.ts)
and [VariableEditor.tsx](../apps/web/src/inspector/VariableEditor.tsx)
ended up with **zero automated coverage**: anything behind `import "lexical"`
was caught only by manual browser passes. Commit `907dea2` shipped that
gap into prod: `VariableNode`'s constructor called the mutating
`setMode("token")`, which on an *attached* node recurses
`clone() → new VariableNode(...) → setMode() → getWritable() →
$cloneWithProperties() → clone() → …` until the stack blows
(`RangeError: Maximum call stack size exceeded`) and Lexical's error
boundary trips on the first chip Backspace. The pure bridge tests had
nothing to say, `npm test` was green, and the bug was only caught by a
live browser pass.
**Decision:** Introduce a **second test tier** in `apps/web`, explicitly
**install-required**, sitting outside the default `npm test` glob:
- **Tier 1 — default `npm test` = install-free cold-checkout gate.**
  `check:ir` + `test:ir` + `test:codegen` + `test:web` over
  `apps/web/test/**/*.test.ts`. Unchanged; still the gate for the IR
  contract, codegen golden output, and the pure reducer / bridge family
  ([ADR-0022](DECISIONS.md) / [ADR-0023](DECISIONS.md) /
  [ADR-0024](DECISIONS.md) / [ADR-0025](DECISIONS.md) /
  [ADR-0026](DECISIONS.md) / [ADR-0027](DECISIONS.md) /
  [ADR-0028](DECISIONS.md) / [ADR-0029](DECISIONS.md) /
  [ADR-0030](DECISIONS.md)).
- **Tier 2 — `npm run test:web:dom` = install-required Lexical/DOM tests.**
  New script in the root [package.json](../package.json):
  `"test:web:dom": "node --test \"apps/web/test-dom/**/*.test.ts\""`,
  plus a sibling `"test:dom"` in
  [apps/web/package.json](../apps/web/package.json). Uses
  `@lexical/headless` (added as an `apps/web` devDependency, pinned to
  `^0.45.0` to match the already-pinned `lexical` /
  `@lexical/react`). **Not** wired into the root `"test"` script — the
  default gate stays install-free.
- **Sibling `test-dom/` directory, deliberately not `test/dom/`.** The
  default glob is `node --test "test/**/*.test.ts"` (in
  [apps/web/package.json](../apps/web/package.json)); a nested
  `test/dom/` would be matched by that glob and pull `lexical` into the
  cold-checkout gate the moment a developer ran `npm test` without
  installing first. The sibling name is invisible to the default glob.
  Pinned as a trap in the slice prompt and verified by running the
  default gate.
- **First test is the `907dea2` regression.**
  [apps/web/test-dom/variableNode.dom.test.ts](../apps/web/test-dom/variableNode.dom.test.ts):
  (1) seeds a headless editor from
  `segmentsToEditorState(cityTimeReportSegments)` so chips land in the
  *attached* slot, then in a *separate* `editor.update` calls
  `.remove()` on an attached chip (the path that triggers
  `getWritable()` → `clone()`) and asserts no error was forwarded to
  `onError`. With the buggy constructor reinstated, this test fails
  with `Maximum call stack size exceeded` — sanity-checked at slice
  time and reverted. (2) Real-Lexical round-trip: seeds the editor,
  exports via `editor.getEditorState().toJSON()`, asserts
  `editorStateToSegments(...)` equals the original segments. Catches
  shape drift between `VariableNode.exportJSON()` and the bridge that
  the pure bridge test cannot see. (3) Token mode preserved across an
  attached-node clone — pins our dependency on Lexical's
  `$cloneWithProperties` copying `__mode` for TextNodes, so a future
  upstream change that loses that copy fails loud.
- **`onError` captures, not thrown propagation.** Lexical wraps update
  callbacks; a thrown error inside `editor.update` is forwarded to the
  configured `onError`, not propagated past `editor.update(...)`. The
  test helper collects errors in an array and asserts the array is
  empty — that is the precise oracle the regression needs.
- **No CI file added.** None exists in the repo today; the ADR is the
  signpost. When CI is added it should run both tiers — the default
  `npm test` for the cold-checkout posture and
  `npm run test:web:dom` (after `npm install` in `apps/web`) for the
  Lexical layer. Until then, `test:web:dom` is run manually as part of
  a slice's verification when it touches the Lexical layer.
- **Pre-existing cold-checkout drift, not addressed here.** With the
  apps/web `node_modules` directory removed,
  `apps/web/test/irStore.test.ts` already fails because
  [irStore.ts](../apps/web/src/store/irStore.ts) imports `zustand` at
  runtime (introduced by [ADR-0022](DECISIONS.md)'s store wrapper). This
  predates this slice and is unaffected by it — the tier added here
  does not widen the surface. Closing that gap properly (e.g. making
  the store wrapper lazy, or moving the affected tests behind a tier)
  is a focused follow-up; this slice's scope is the Lexical layer.
- **`packages/*` frozen.** No validator codes added, no codegen behavior
  change, no IR shape change. The slice is `apps/web`-only:
  `apps/web/package.json` (devDep + `test:dom` script), root
  `package.json` (`test:web:dom` script), and the new test file.
**Consequences:** The Lexical/DOM layer now has automated coverage and a
canonical regression test (`907dea2`). Manual browser passes remain
valuable for styling, real DOM events, and full editor UX, but they are
no longer the only safety net for the chip atom invariants. Future
Lexical-touching slices (e.g. DnD chip insertion, deferred from
[ADR-0030](DECISIONS.md)) can extend `apps/web/test-dom/` without
re-architecting either tier. The cold-checkout posture for the IR /
codegen / bridge surfaces stays exactly as it was.

## ADR-0032 — Restore install-free `npm test`; generalize the install-required tier from `test-dom/` to `test-app/`
**Context:** [CLAUDE.md](../CLAUDE.md) declares as a keystone that
`npm test` runs from a cold checkout with no `npm install`. That is
the invariant [ADR-0011](DECISIONS.md) / [ADR-0013](DECISIONS.md)
established, and it is what makes the default gate a true
cold-checkout proof. [ADR-0031](DECISIONS.md) — the slice that
introduced the install-required `test:web:dom` second tier — flagged
a pre-existing drift from this invariant: `apps/web/test/irStore.test.ts`
imports `createIRStore` from
[apps/web/src/store/irStore.ts](../apps/web/src/store/irStore.ts),
which imports `zustand` at runtime ([ADR-0022](DECISIONS.md) store
wrapper). With root `node_modules` absent, `npm test` failed loud on
`Cannot find package 'zustand'`. ADR-0031 explicitly deferred this
fix; this slice is the deferred fix.
**Decision:** Three coordinated changes, all in `apps/web` and root
`package.json`. `packages/*` untouched.
- **Tier 2 generalized.**
  `apps/web/test-dom/` → `apps/web/test-app/`. The tier introduced by
  ADR-0031 was named after its first inhabitant (Lexical/DOM tests),
  but its real defining property is "needs `apps/web` deps." Renaming
  while the tier still holds one file is cheap; deferring would
  entrench the misnomer. Scripts renamed in lockstep:
  `"test:web:dom"` → `"test:web:app"` in root [package.json](../package.json)
  with glob `node --test "apps/web/test-app/**/*.test.ts"`; sibling
  `"test:dom"` → `"test:app"` in
  [apps/web/package.json](../apps/web/package.json). Still NOT chained
  into the default `"test"` script — Tier 2 is run on demand or by CI
  after `npm install`, never by the cold-checkout gate. ADR-0031's
  body is left as historical record of the original `test-dom/`
  naming.
- **`irStore.test.ts` split by import surface.** The original file
  mixed pure-reducer tests (which only import
  [irReducer.ts](../apps/web/src/store/irReducer.ts) +
  [segmentsBridge.ts](../apps/web/src/inspector/segmentsBridge.ts) +
  the validator/codegen) with store-action tests (which import
  `createIRStore` and therefore `zustand`). Split into two files,
  same tests, no behavior change:
  - **`apps/web/test/irReducer.test.ts`** (install-free; renamed from
    `irStore.test.ts` because the file no longer touches the store):
    `applyModelParamPatch`, the two `applyNodeConfigPatch` cases
    (function `outputType`, router `routes`), all three
    `applyNodePosition` cases, and the ADR-0029 bridge
    round-trip + codegen test.
  - **`apps/web/test-app/irStore.test.ts`** (install-required, Tier 2):
    the two `updateNodeConfig(...)` flows-through tests (titled after
    the store action they prove) plus the three `createIRStore`
    tests — `store.deleteNode` clears selection, `replaceIR` swaps
    + clears selection, `store.setNodePosition` Save-IR round-trip.
- **`test-app/` is a sibling of `test/`, never `test/app/`.** The
  `apps/web` default `"test"` glob is `test/**/*.test.ts`; a nested
  `test/app/` would be re-pulled into the cold-checkout gate and
  re-break the invariant this slice restores. Pinned as a trap in
  the slice prompt; the sibling layout is what makes the rule crisp.
- **The crisp rule.** `test/** = install-free; test-app/** = install-required`.
  Anything that imports `zustand`, `lexical`, React, `react-dom`, or
  any other `apps/web` runtime dep lives in `test-app/`. Anything
  that imports only IR types, Node builtins, and pure reducer /
  bridge modules lives in `test/`. New Lexical-touching slices
  (e.g. DnD chip insertion, deferred from [ADR-0030](DECISIONS.md))
  extend `test-app/` directly.
- **Verified by cold-checkout sim.** Acceptance test was running
  `npm test` with both root and `apps/web` `node_modules` moved
  aside: 75 tests passed, zero failures. (`apps/web/node_modules`
  in this workspace only ever held vite caches — npm workspaces
  hoist all real deps to root — but the sim moves both for
  belt-and-braces.) With deps restored: `npm run test:web:app`
  green (8 tests — 5 store-action + 3 Lexical), default `npm test`
  green (75 tests). `git diff --name-only main -- packages/` empty.
**Consequences:** The cold-checkout invariant declared by CLAUDE.md
is now true again — not just for `packages/*` but for the full
default `npm test`. The two-tier rule is crisp: file location is the
contract. Tier 2's name no longer leaks its first-inhabitant
history. The next time someone writes a test that imports a runtime
dep, the choice is mechanical — `test-app/`, not "is this DOM
enough to count as `test-dom/`?".

## ADR-0033 — UI/UX pass: the "Drafting Table" visual system
**Context.** Phase 0–2 built a *functional* but visually utilitarian builder (inline-ish CSS,
default React Flow chrome, system sans). Before Phase 3 (draw.io) the user asked for a UI/UX
polish. The product's essence — a hand-arranged visual graph that gets **manufactured into
runnable Python** — suggested an engineer's-drafting-table metaphor, which this slice commits to.
Presentation-only: **no store / IR / codegen / component-logic changes**; `packages/*` untouched.

**Decisions.**
- **Aesthetic: "Drafting Table."** Warm vellum paper (`--paper #f3efe6`), warm-black ink, and a
  **single vermilion "red-pencil" accent** (`--accent #cf4d2c`) used for the primary action,
  selection, handles, and prompt chips. One accent, used decisively, over a timid multi-color
  palette. A faint drafting grid sits behind the shell; the canvas gets a real **blueprint grid**
  (layered fine `Lines` + coarse `Cross` `<Background>` in paper-toned ink).
- **Type system (distinctive, not Inter/Roboto):** `Fraunces` (characterful serif) for the
  wordmark only — one memorable typographic moment; `IBM Plex Sans` for UI; `IBM Plex Mono` for
  everything code-shaped (node identifiers, panel labels, chips, the preview, buttons) to reinforce
  "this is a code tool." Loaded via Google Fonts with serif/system/mono fallback stacks, so the
  layout degrades gracefully if the CDN is unreachable.
- **Node-type color-coding (a UX win, not just paint):** seven earthy hues (agent/function/router/
  tool/join/humanInput/workflow) applied **consistently** to the palette swatch tick *and* the
  canvas node's left border + type label, via a `data-node-type` attribute the components emit
  (`IRNode`, `Palette`). Recognizing a node's kind at a glance now works the same in both panes.
- **UX additions surfaced from existing state:** a real **wordmark** (`graphical·agents` / `IR →
  ADK`), an at-a-glance **validity pill** (green "valid" vs. red "N errors") driven by the
  `errorCount` the Toolbar already computed, and the **Download .zip** payoff promoted to a
  primary (vermilion) button. Panel headers became small-caps mono with a registration-tick glyph.
  The preview renders into a dark "manufactured output" ink slab. One restrained page-load moment:
  staggered pane reveal (`@keyframes paneIn`), disabled under `prefers-reduced-motion`.
- **Touched files (6, presentation-only):** `index.html` (fonts, title, inline-SVG favicon —
  also kills the prior favicon 404), `styles.css` (full design-system rewrite, same class names so
  markup is undisturbed), `Toolbar.tsx` (wordmark + validity pill + primary class), `IRNode.tsx`
  and `Palette.tsx` (`data-node-type` only), `Canvas.tsx` (`<Background>` props only). All handler
  logic, store wiring, and the IR are byte-for-byte unchanged.

**Verification.** No headless oracle for visuals (per the UI-slice norm). Vite production build
clean; default `npm test` 13+85+75 green and `test:web:app` 8/8 green (unchanged — no test asserts
on DOM markup); live browser pass (overview, inspector with the Lexical editor + chips, fit-view
graph) confirmed the system renders cohesively with **zero console errors**.

**Consequences.** The builder now has a distinctive, cohesive identity without any behavioral
change or risk to the verified Phase 0–2 core. New surfaces (e.g. the forthcoming draw.io import
controls) inherit the design tokens in `:root`. Out of scope (noted, not regressions): the
fixture's wide node spread still fits-to-view small; no dark mode; fonts are a runtime CDN
dependency with graceful fallback.

## ADR-0034 — Palette drag-and-drop: drop a node at the cursor
**Context.** The palette was click-to-add only (ADR-0025): a new node landed at a staggered
default position (`defaultPositionFor`, +280px right of the rightmost node). Node drag (ADR-0028)
made positions first-class in the IR. The natural next gesture — *drag a palette item onto the
canvas and have the node land where you drop it* — was the user's requested precursor to draw.io.

**Decisions.**
- **The store still owns the node; the only new capability is an explicit drop position.** The pure
  reducer gains one optional param: `addNode(ir, type, position?: UiPosition)` —
  `const ui = position ?? defaultPositionFor(ir)`. Click-to-add is unchanged (passes no position →
  same stagger); drag passes the drop point. The store action mirrors it: `addNode(type, position?)`.
  No new reducer, no new validation — the dropped node is unwired and Preview surfaces the same
  honest `UNREACHABLE_NODE` finding as a clicked one (ADR-0025/0026 posture).
- **Standard React Flow DnD, adapted to store-owns-everything.** The palette item is `draggable`
  and sets the node type on a custom MIME (`application/ga-node-type`, exported as `NODE_DND_MIME`
  so palette and canvas agree). The canvas wraps `<ReactFlow>` in a `.canvas-drop` target that
  handles `onDragOver` (preventDefault + `dropEffect="move"`, gated on the MIME so unrelated drags
  are ignored) and `onDrop` (read the type, `screenToFlowPosition({x,y})` → `addNode(type, pos)`).
  The RF instance is captured via `onInit` into a **ref** (not state — it's read imperatively in
  `onDrop`, nothing renders off it).
- **Layout: the canvas pane became a flex column.** `.canvas-drop` is `flex:1; min-height:0` under
  a `display:flex; flex-direction:column` canvas pane, so the drop hit-zone fills the whole canvas
  area below the header and React Flow inherits a clean height. (Previously RF sized off the grid
  cell with an `overflow:auto` quirk; this is tidier and removes it.)
- **Click-to-add stays.** Dragging is additive — the click path remains for accessibility and
  speed. The palette title now reads "Drag onto the canvas, or click to add…".

**Headless oracle.** One test in `apps/web/test/addNode.test.ts`: `addNode(ir, type, {x,y})` writes
the position verbatim to `node.ui`; omitting it keeps the staggered default (sits right of the
graph) — pinning that the drop path and click path don't collapse into each other. (The DnD wiring
itself — dataTransfer, `screenToFlowPosition` — is browser-only and has no headless oracle.)

**Verification.** Default `npm test` 13+85+76 green (the +1 is the position test); `test:web:app`
8/8; Vite build clean. Live browser pass: a real drag of the Tool palette item onto the canvas
created `tool_1` at the drop point, auto-selected with the inspector open, Preview honestly flagged
`UNREACHABLE_NODE`, and the validity pill flipped to "1 error" with Download auto-disabled — zero
console errors. `packages/*` untouched.

**Consequences.** The canvas is now a full drag-build surface. This also de-risks draw.io (Phase 3):
the drop→`addNode(type, position)` path is the same shape an importer will use to materialize parsed
nodes at their diagram coordinates. Out of scope: drag-to-reposition existing palette categories,
drag-to-connect-on-drop, multi-drop.
