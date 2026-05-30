# graphical-agents — Project Brief

Visual builder that compiles a drag-and-drop agent graph into runnable **Google ADK
(Python, v2.0.0) graph-workflow** projects. Also imports **draw.io** XML into the same graph.

## The one rule: the IR is the source of truth
Every input (visual builder, draw.io import) produces a **Graph IR** — a versioned JSON
document defined in `packages/ir`. Validation, code generation, and save/load all operate on
the IR. **Never generate code directly from UI state or XML; always go through the IR.**

```
UI / draw.io  →  IR  →  validator  →  codegen  →  runnable ADK project (.zip)
```

## Code generation pipeline (do not shortcut)
```
IR → edges compiler → per-node template fragments → assemble modules
   → import dedupe → format (black) → syntax check → bundle project scaffold
```

## Module boundaries (= context boundaries)
- `packages/ir`      IR JSON Schema + TS types + validator. **The keystone.** Everything depends on it.
- `packages/codegen` IR → ADK project. Templates + edges compiler + golden tests.
- `packages/drawio`  mxGraph XML → IR.
- `apps/web`         React Flow canvas + Lexical prompt editor. Depends only on `packages/ir` types.

A session works in **one** package. Load `packages/ir` types + that package; nothing else.

## Scope (v1)
- **IN:** declarative graphs — sequence, router/branch, parallel fan-out, JoinNode, HumanInput,
  nested Workflow, Tools. Agents run in single-turn / task mode.
- **OUT:** ADK *dynamic* workflows (`@node` / `ctx.run_node` / loops / recursion) — imperative,
  not a visual graph.
- Non-adjacent variables via session `state`: **deferred to Phase 3** (schema-passing first).
- draw.io: **import only**.

## Working method (how to run a session)
- One scoped slice per session. Plan before editing. **End green + committed.**
- Append non-obvious choices to `docs/DECISIONS.md`.
- Golden-file tests are the codegen spec; the validator is the IR spec. Let tests be the feedback loop.
- Every session must be startable cold from these artifacts — if a session only works because of
  prior chat, the artifact is too thin. Fix the artifact, don't lengthen the conversation.

## Verify
- **Phase 0 (no Node yet):** `python3 scripts/check_ir.py packages/ir/fixtures/city-time.ir.json`
- **Once Node ≥18 is installed:** `npm install && npm test`

## Key ADK facts the generator relies on
- `Workflow(edges=[...])` where a row is a sequence chain; `("START", ...)` begins a graph;
  `START` may repeat (parallel fan-out).
- Router: a function returns `Event(route=...)` → a row `(router, {route: target})`.
- Data flow is **positional**: `Event(output=...)` → next node's `node_input`. **One output per node.**
- Agent prompt variables: `{Schema.field}` or source-bound `<Schema.field from node_name>`.
  **We always emit the source-bound form.**
- `JoinNode` waits for all upstreams; every upstream needs a failsafe output or it hangs.
- HumanInput = `RequestInput(message, payload?, response_schema?)`; does not reformat responses.

See `docs/ARCHITECTURE.md` for the full blueprint, `docs/IR-SCHEMA.md` for the IR contract,
and `docs/DECISIONS.md` for the decision log.
