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
