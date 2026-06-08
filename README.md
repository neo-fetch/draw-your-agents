# Graphical Agents

![Project Screenshot](https://github.com/neo-fetch/draw-your-agents/blob/main/assets/sc%201.png?raw=true)

A visual builder that compiles drag-and-drop agent graphs into runnable **[Google ADK](https://adk.dev/) (Python, v2.0.0) graph-workflow** projects. Also imports **draw.io** XML diagrams into the same graph.

> **Status:** Phase 0 (headless codegen) ✅ — Phase 1 (visual builder) ✅ — Phase 2 (variable chips + schema editor) ✅ — Critic/reviser **loop node**, **nested pydantic models**, **editable node names** ✅ — draw.io import 🔜

---

## ✨ Features
![Project Screenshot](https://github.com/neo-fetch/draw-your-agents/blob/main/assets/sc%200.png?raw=true)

### Visual Graph Builder
- **Drag-and-drop canvas** — Drag node types from the palette onto a React Flow canvas (drops at the cursor), then connect and freely arrange them
- **Editable node names** — Rename any node in place; references (prompt-variable sources, tool lists) cascade automatically
- **Full config inspector** — Edit every node property (model, instruction, schemas, routes, tools, etc.) with type-dispatched forms
- **Live code preview** — See the generated ADK Python project update in real time as you edit the graph
- **One-click export** — Download a runnable `.zip` project scaffold ready for `pip install && python -m workflow`
- **"Drafting Table" UI** — A distinctive vellum-and-ink design: blueprint canvas grid, per-type color-coding, at-a-glance graph-validity pill

### Variable-Chip System (Phase 2 — Headline Feature)
- **Inline prompt variables** — Drag schema fields into an agent's prompt as chips rendered `<Schema.field from node>`
- **Auto-wiring** — Inserting a chip automatically sets the agent's `inputSchemaRef`
- **Single-schema rail** — The palette intelligently filters to one schema per agent, enforcing ADK's data-flow constraints
- **Schema CRUD** — Create, rename, and delete schemas and fields directly in the UI; references cascade on rename
- **Nested pydantic models** — A schema field's type can be another declared schema (`customer: Customer`); the validator rejects cycles and codegen emits the models in dependency order

### Iterative Refinement — Critic/Reviser Loop
- **Loop node** — A self-contained *generate → critique → revise* loop that iterates until an LLM critic approves (or a max-iteration cap)
- **Compiles to a real ADK dynamic workflow** — Codegen emits an `@node` orchestrator (`ctx.run_node` + a bounded Python loop) modeled on a verified working example, placed as one node so the outer graph stays an acyclic DAG
- **Typed payloads** — Generator/critic/reviser exchange pydantic-typed I/O (composes with nested schemas); a canonical `{status, feedback}` critic output drives termination

### Code Generation Pipeline
- **Full v1 declarative coverage** — Agent, Function, Router, JoinNode, HumanInput, nested Workflow, and Tool nodes all compile end to end
- **Proven against real ADK** — Every generated project constructs successfully against `google-adk==2.0.0` ([ADR-0021](docs/DECISIONS.md))
- **Golden-file tested** — The codegen output is pinned by golden files; the validator is the IR spec

### Graph IR — The Single Source of Truth
- **One canonical IR** — Every input (visual builder, draw.io) produces a versioned JSON Graph IR. Validation, codegen, and save/load all operate on the IR — never directly on UI state or XML ([ADR-0001](docs/DECISIONS.md))
- **Recursive** — Nested workflows carry a complete sub-IR in `config.graph`, validated recursively with the same rules
- **Flat global namespace** — Node and schema names are unique across all nesting levels

---

## 🏗 Architecture

```
UI / draw.io  →  IR  →  validator  →  codegen  →  runnable ADK project (.zip)
```

### Code Generation Pipeline (detailed)
```
IR → edges compiler → per-node template fragments → assemble modules
   → import dedupe → format (black) → syntax check → bundle project scaffold
```

### Generated Output (a runnable project, not one file)
```
my_workflow/
  workflow.py        # root_agent = Workflow(edges=[...])
  agents.py          # Agent(...) with model params + instruction
  functions.py       # function / router / join / humanInput bodies
  loops.py           # @node critic/reviser orchestrators (emitted when loop nodes exist)
  schemas.py         # Pydantic BaseModels for every input/output schema
  requirements.txt   # google-adk==2.0.0
  .env.example
  README.md
```

### Node Taxonomy

| IR `type`     | ADK construct        | Key config                                       |
|---------------|----------------------|--------------------------------------------------|
| `agent`       | `Agent` / `LlmAgent` | model, instruction (structured template), modelParams, mode, tools, schemas |
| `function`    | `def f(node_input)`  | description, inputType, outputType, emits, body   |
| `router`      | fn → `Event(route=)` | routes[], body; branch targets via edge `route`    |
| `tool`        | `FunctionTool`       | inputType, outputType, body                       |
| `join`        | `JoinNode`           | waits for all upstreams                           |
| `humanInput`  | `RequestInput`       | message, payloadRef, responseSchemaRef            |
| `workflow`    | nested `Workflow`    | sub-IR in `config.graph`                          |
| `loop`        | `@node` orchestrator | maxIterations, approvalPhrase, input/payload types, generator + critic + reviser sub-agents |

---

## 📁 Project Structure

```
graphical-agents/
├── packages/
│   ├── ir/                    # 🔑 The keystone — IR types, JSON Schema, TS validator
│   │   ├── src/
│   │   │   ├── types.ts       # GraphIR, GraphNode, Edge, all config types
│   │   │   └── validate.ts    # Authoritative IR validator (structured findings)
│   │   ├── schema/            # JSON Schema for the IR format
│   │   ├── fixtures/          # Worked-example IR files (city-time, routing, parallel, etc.)
│   │   └── test/              # Validator spec tests
│   │
│   └── codegen/               # IR → ADK project generator
│       ├── src/
│       │   ├── edges.ts       # Edges compiler (linearizes the graph into ADK edge rows)
│       │   ├── fragments.ts   # Per-node template fragments (renderAgent, renderFunction, etc.)
│       │   ├── project.ts     # Project assembler (stitches fragments into modules)
│       │   ├── compile.ts     # validate → generateProject entry point
│       │   ├── format.ts      # Black formatter integration
│       │   ├── bundle.ts      # Pure-TS STORE-only .zip bundler (browser-compatible)
│       │   └── python.ts      # Python code generation helpers
│       └── test/
│           ├── golden/        # Golden-file test fixtures (the codegen spec)
│           └── *.test.ts      # Edges, project, compile, format, bundle tests
│
├── apps/
│   └── web/                   # Visual builder — React Flow + Lexical + Zustand
│       ├── src/
│       │   ├── App.tsx         # Shell: Palette | Canvas | Inspector | Preview
│       │   ├── canvas/        # React Flow canvas + custom node types
│       │   ├── inspector/     # Type-dispatched config forms + Lexical prompt editor
│       │   │   ├── Inspector.tsx
│       │   │   ├── VariableEditor.tsx    # Lexical editor with chip support
│       │   │   ├── VariableNode.ts       # Lexical TextNode subclass for variable chips
│       │   │   ├── VariablePalette.tsx   # Field insertion palette (single-schema rail)
│       │   │   └── segmentsBridge.ts     # Pure segments↔Lexical JSON bridge (install-free)
│       │   ├── store/         # Zustand IR store + pure reducers
│       │   │   ├── irStore.ts            # Zustand store (UI's single source of truth)
│       │   │   ├── irReducer.ts          # Config patch + model param + position reducers
│       │   │   ├── addNode.ts            # Node minting with unique id/name generation
│       │   │   ├── irEdges.ts            # Connect, delete node/edge, set route reducers
│       │   │   ├── insertVariable.ts     # Variable insertion + candidate logic
│       │   │   ├── schemas.ts            # Schema/field CRUD reducers
│       │   │   └── irIO.ts              # Save/load IR JSON
│       │   ├── preview/       # Live code preview (runs compile() client-side)
│       │   ├── palette/       # Node type palette (click-to-add)
│       │   ├── schemas/       # Schema CRUD panel
│       │   ├── toolbar/       # Save/Load/Download toolbar
│       │   └── styles.css     # All styles
│       ├── test/              # Install-free headless tests (tier 1)
│       └── test-app/          # Install-required DOM tests (tier 2)
│
├── scripts/
│   ├── check-ir.ts            # CLI: validate IR fixtures
│   ├── compile.ts             # CLI: IR → .zip end-to-end
│   └── check_ir.py            # Superseded Python validator (historical reference)
│
├── docs/
│   ├── ARCHITECTURE.md                # Architecture blueprint
│   ├── DECISIONS.md                   # Append-only ADR log (ADR-0001 through ADR-0040)
│   ├── IR-SCHEMA.md                   # IR contract documentation
│   ├── PHASE-2-DESIGN.md             # Variable-chip system design
│   ├── PHASE-NESTED-SCHEMAS-DESIGN.md # Nested pydantic models design
│   └── PHASE-SUBAGENTS-DESIGN.md     # Critic/reviser loop node design
│
├── CLAUDE.md                  # Project brief & session rules
├── package.json               # Monorepo root (npm workspaces)
├── tsconfig.base.json         # Shared TypeScript config
└── LICENSE                    # AGPL-3.0
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js ≥ 23** (uses native TypeScript execution via type-stripping)
- **Python 3** (optional — for `black` formatting and `py_compile` trust gate)

### Quick Start (headless — no install needed)

The IR validator, codegen golden tests, and pure reducer tests all run from a cold checkout with **zero `npm install`**:

```bash
git clone <repo-url>
cd graphical-agents
npm test
```

This runs:
1. `check:ir` — TS validator over all IR fixtures
2. `test:ir` — Validator spec tests
3. `test:codegen` — Golden-file codegen tests
4. `test:web` — Pure reducer / bridge headless tests

### Visual Builder (requires install)

```bash
cd apps/web
npm install
npm run dev
```

Opens the visual builder at the Vite dev URL. Load an IR fixture from `packages/ir/fixtures/` via the toolbar's **Load IR** button.

### CLI: Compile an IR to a .zip

```bash
node scripts/compile.ts packages/ir/fixtures/city-time.ir.json
# Outputs: city_time_workflow.zip
```

---

## 🧪 Testing

### Two-Tier Test Architecture

| Tier | Command | Requires Install? | What it covers |
|------|---------|-------------------|----------------|
| **1 — Default gate** | `npm test` | No | IR validator, codegen goldens, pure reducers, segments bridge |
| **2 — DOM tests** | `npm run test:web:app` | Yes (`apps/web`) | Lexical integration, VariableNode regressions, real editor round-trips |

**Tier 1** is the cold-checkout gate — it proves the IR contract, codegen output, and every pure reducer without pulling in React, Zustand, or Lexical.

**Tier 2** covers the Lexical layer that tier 1 deliberately can't reach (it imports `lexical`). Uses `@lexical/headless`.

### Individual test suites

```bash
npm run check:ir         # Validate IR fixtures
npm run test:ir           # Validator spec tests
npm run test:codegen      # Golden-file codegen tests
npm run test:web          # Pure reducer / bridge tests (install-free)
npm run test:web:app      # DOM / Lexical tests (install-required)
```

### Optional: Python trust gate

```bash
# With black installed:
pip install black
# The format.test.ts idempotence check will run (skipped gracefully without black)

# py_compile trust gate runs automatically in project.test.ts
# (requires python3 on PATH)
```

---

## 🛠 Development

### Working Method

- **One scoped slice per session.** Plan before editing. End green + committed.
- **Append non-obvious choices** to [`docs/DECISIONS.md`](docs/DECISIONS.md).
- **Golden-file tests are the codegen spec**; the validator is the IR spec. Let tests be the feedback loop.
- **The IR is the source of truth.** Never generate code directly from UI state — always go through the IR.

### Module Boundaries

| Package | Role | Dependencies |
|---------|------|--------------|
| `packages/ir` | IR types + JSON Schema + validator. **The keystone.** | None |
| `packages/codegen` | IR → ADK project (templates + edges compiler + golden tests) | `packages/ir` (types only) |
| `apps/web` | React Flow canvas + Lexical prompt editor + Zustand store | `packages/ir` (types), `packages/codegen` (runtime) |

### Frontend Stack

| Library | Version | Role |
|---------|---------|------|
| React | 19 | UI framework |
| React Flow (`@xyflow/react`) | 12 | Canvas / nodes / typed handles |
| Lexical | 0.45 | Prompt editor with inline variable chips |
| Zustand | 5 | IR store (single source of truth) |
| Vite | 7 | Dev server + bundler |

### Key Design Patterns

- **Pure reducers** — All IR mutations are pure functions in `apps/web/src/store/*.ts`, tested under `node --test` without any framework imports
- **Store-not-RF-owns-edges** — React Flow renders in controlled mode from the IR store; `onConnect`/`onDelete` dispatch reducer actions
- **Seed-once-per-node** — The Lexical editor mounts from segments once per agent (`key={node.id}`); the editor is the local authority during editing, pushing changes out via `onChange`
- **Validator owns the spec** — The UI never re-implements validation rules; it surfaces `validate()` findings in the Preview pane

---

## 🗺 Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 0** | ✅ Complete | IR schema + edges compiler + templates + golden tests (headless) |
| **Phase 1** | ✅ Complete | Visual builder MVP (canvas, inspector, live preview, save/load, .zip download) |
| **Phase 2** | ✅ Complete | Variable-chip system (Lexical editor, insert palette, auto-wire, schema CRUD) |
| **Phase 2.5** | ✅ Complete | Editable node names, nested pydantic models, critic/reviser **loop node** (contained dynamic workflow) |
| **Phase 3** | 🔜 Next | draw.io XML ingestion (`mxGraph XML → IR`) |
| **Phase 4** | 📋 Planned | Python fidelity service (`black` + `compile()` + dry-run `Workflow(...)`) |
| **Phase 5** | 📋 Planned | Polish, session-state variables, undo/redo |

---

## 📝 Key ADK Facts the Generator Relies On

- `Workflow(edges=[...])` where a row is a sequence chain; `("START", ...)` begins a graph; START may repeat (parallel fan-out)
- Router: a function returns `Event(route=...)` → a row `(router, {route: target})`
- Data flow is **positional**: `Event(output=...)` → next node's `node_input`. **One output per node.**
- Agent prompt variables: always emitted in the source-bound form `<Schema.field from node_name>`
- `JoinNode` waits for all upstreams; every upstream needs a failsafe output or it hangs
- HumanInput = `RequestInput(message, payload?, response_schema?)`

---

## 📄 Documentation

- [Architecture Blueprint](docs/ARCHITECTURE.md) — Full system design
- [Decision Log (ADRs)](docs/DECISIONS.md) — Append-only architectural decision records (ADR-0001 through ADR-0040)
- [IR Schema Contract](docs/IR-SCHEMA.md) — Graph IR format specification
- [Phase 2 Design](docs/PHASE-2-DESIGN.md) — Variable-chip system design & slice plan
- [Nested Schemas Design](docs/PHASE-NESTED-SCHEMAS-DESIGN.md) — Nested pydantic models design & slice plan
- [Loop Node Design](docs/PHASE-SUBAGENTS-DESIGN.md) — Critic/reviser loop (dynamic workflow) design & slice plan

---

## 📜 License

[GNU Affero General Public License v3.0](LICENSE)
