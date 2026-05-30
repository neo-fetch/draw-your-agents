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
