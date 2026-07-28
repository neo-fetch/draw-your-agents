# Architecture Blueprint

## 1. The hub: a canonical IR
All inputs produce one versioned **Graph IR** (JSON). Validation, code generation, and save/load
operate only on the IR. draw.io import = "XML → IR", then the IR loads onto the canvas like any
saved project. See [ADR-0001](DECISIONS.md).

```
UI / draw.io  →  IR  →  validator  →  codegen  →  runnable ADK project (.zip)
```

## 2. Node taxonomy
`START` is not a node — it is the literal `"START"` used as an edge `from`.

| IR `type`   | ADK construct            | Key config                                                        | Emits            |
|-------------|--------------------------|-------------------------------------------------------------------|------------------|
| `agent`     | `Agent` / `LlmAgent`     | model, instruction (w/ vars), modelParams, mode, tools, in/out schema | `output`     |
| `function`  | `def f(node_input)`      | description, inputType, outputType, emits, body                   | `Event(output=)` |
| `router`    | fn returning `Event(route=)` | routes[], body; branch targets on edges via `route`           | `Event(route=)`  |
| `tool`      | ADK `Tool`               | tool ref / params (Phase 3)                                        | `output`         |
| `join`      | `JoinNode`               | (waits for all upstreams)                                          | collected output |
| `humanInput`| `RequestInput`           | message, payloadRef, responseSchemaRef                            | user input       |
| `workflow`  | nested `Workflow`        | sub-IR ref (Phase 3)                                               | bubbles leaf out |

Agents must be single-turn / task mode (ADK constraint).

## 3. Data-flow & variable model (the headline feature)
- ADK Event channels: `output` (standard payload → next node's `node_input`, **one per node**),
  `message` (user-facing), `state` (session-wide; **non-adjacent variables shipped** — ADR-0051).
- Agent `instruction` is stored as a **structured template** (segments), not a raw string, so it
  can be re-rendered on rename and validated:

```jsonc
"instruction": { "segments": [
  { "type": "text", "value": "It is " },
  { "type": "var", "schema": "CityTime", "field": "time_info", "source": "lookup_time" },
  { "type": "text", "value": " right now." }
]}
```

- Each `var` segment renders to the source-bound form `<CityTime.time_info from lookup_time>`
  ([ADR-0008](DECISIONS.md)) and creates a data dependency `source → thisNode`.
- **Dropping a chip can mutate the producer:** if the source emits `str`, it must be upgraded to a
  structured `output_schema` that contains the field; the consumer's `inputSchemaRef` is set to that
  schema. Validator enforces this. ([ADR-0006](DECISIONS.md))
- **Non-adjacent variables** (`via: "state"`, [ADR-0051](DECISIONS.md)): a `var` segment may instead
  read from session `state` for **any ancestor** node — rendered as the `{schema.field}` ADK session
  form (LangGraph reads `state["<source>_output"].<field>`). Exempt from the single-schema rail;
  the validator hard-errors a non-ancestor source (`STATE_VAR_SOURCE_NOT_ANCESTOR`).

## 4. Edges compiler (`packages/codegen`)
The IR is a plain directed graph. The compiler linearizes it into ADK `edges=[...]`:
collapse linear chains → sequence rows; routers → `(router, {route: target})`; joins → fan-in rows
+ continuation; a repeated row head (START or an interior node) is parallel fan-out
(ADR-0048). A non-terminal router branch target continues in its own row headed by that target
(ADR-0054). Highest-risk module → golden-file tests.
([ADR-0009](DECISIONS.md))

## 5. Code generation pipeline ([ADR-0003](DECISIONS.md))
```
IR → edges compiler → per-node template fragments → assemble modules
   → import dedupe → format (black) → syntax check → bundle project scaffold
```
Runs client-side (TS) for live preview. Trust gate before download is the Python fidelity service
([ADR-0004](DECISIONS.md)): `black` + `compile()` + dry-run `Workflow(...)` construction.

### Output artifact (not one file — a runnable project)
```
my_workflow/
  workflow.py      # root_agent = Workflow(edges=[...])  ← edges compiler output
  agents.py        # Agent(...) with model params + instruction
  functions.py     # function / router / join bodies (TODO-stubbed where unknown)
  schemas.py       # pydantic BaseModels for every input/output schema
  requirements.txt # google-adk==2.0.0
  .env.example
  README.md
```

## 6. draw.io ingestion (`packages/drawio`, import only — [ADR-0007](DECISIONS.md))
draw.io = mxGraph XML (`mxGraphModel > root > mxCell`; `vertex="1"` nodes, `edge="1"` edges with
`source`/`target`). Conformance rules: nodes are `<object nodeType="..." ...>` with type-specific
attributes; router branch edges carry the route value as the edge label; one `start` entry.
Parser maps cells → IR, then runs the **same validator**.

## 7. Validation layer (shared; runs on IR before codegen)
Errors block generation; warnings flag. Rules: reachability from START; router completeness
(every route has a target, every branch edge a declared route); join safety (all upstreams reach
it; failsafe outputs); single-output rule; var/schema consistency; agent single-turn mode;
DAG (no cycles in v1); flag live-streaming / incompatible integrations. Warnings render in the
Preview pane as a collapsed, non-blocking strip above the file browser (ADR-0054); errors take the
pane over and disable Export.

## 8. Stack
React Flow + Lexical + Zustand (IR store as source of truth) for `apps/web`; TS templates for
codegen; FastAPI Python fidelity service.

## 9. Roadmap
- **Phase 0** — IR schema + edges compiler + templates + golden tests (headless). *In progress.*
- **Phase 1** — Visual builder MVP (Agent/Function/Router/START, inspector, live preview, zip).
- **Phase 2** — Variable system (chips, source-bound rendering, schema mutation, dependency inference).
- **Phase 3** — Join, parallel, HumanInput, nested Workflow, Tools, session-state variables (ADR-0051).
- **Phase 4** — draw.io ingestion.
- **Phase 5** — Python fidelity service + polish.
