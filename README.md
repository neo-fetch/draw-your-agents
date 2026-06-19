# Graphical Agents

![Project Screenshot](https://github.com/neo-fetch/draw-your-agents/blob/main/assets/choose.png?raw=true)

A visual builder that compiles drag-and-drop agent graphs into runnable Python projects for **two targets from one canonical graph** — **[Google ADK](https://adk.dev/) (v2.0.0) graph-workflows** and **[LangGraph](https://langchain-ai.github.io/langgraph/) (1.x)**. Also imports **draw.io** XML diagrams into the same graph.

Runs entirely in your browser — free for individuals and non-profits, by design. The dark theme, and the ethos behind the whole project, is a tribute to **Bathory** ([why?](#-why-bathory)).

> **Status:** Phase 0 (headless codegen) ✅ — Phase 1 (visual builder) ✅ — Phase 2 (variable chips + schema editor) ✅ — Critic/reviser **loop node**, **nested pydantic models**, **editable node names** ✅ — **LangGraph codegen target** ✅ — **non-adjacent session-`state` variables** ✅ — draw.io import 🔜

---

## ✨ Features
![Project Screenshot](https://github.com/neo-fetch/draw-your-agents/blob/main/assets/init.png?raw=true)

### Visual Graph Builder
- **Drag-and-drop canvas** — Drag node types from the palette onto a React Flow canvas (drops at the cursor), then connect and freely arrange them
- **Editable node names** — Rename any node in place; references (prompt-variable sources, tool lists) cascade automatically
- **Full config inspector** — Edit every node property (model, instruction, schemas, routes, tools, etc.) with type-dispatched forms
- **Two codegen targets, one graph** — Compile the same IR to a **Google ADK** project (default) or a **LangGraph** project; switch targets on the landing page or via the CLI ([ADR-0045 / ADR-0046](docs/DECISIONS.md))
- **Live code preview** — See the generated Python project — **ADK or LangGraph** — update in real time as you edit the graph
- **One-click export** — Download a runnable `.zip` project scaffold (either target) ready to `pip install -r requirements.txt` and run
- **"Drafting Table" UI** — A distinctive vellum-and-ink design: blueprint canvas grid, per-type color-coding, at-a-glance graph-validity pill
![Project Screenshot](https://github.com/neo-fetch/draw-your-agents/blob/main/assets/workflow.png?raw=true)

### Variable-Chip System (Phase 2 — Headline Feature)
- **Inline prompt variables** — Drag schema fields into an agent's prompt as chips rendered `<Schema.field from node>`
- **Auto-wiring** — Inserting a chip automatically sets the agent's `inputSchemaRef`
- **Single-schema rail** — The palette filters to one schema per agent, enforcing the positional data-flow constraint
- **Non-adjacent session-`state` variables** — A second chip category (`{Schema.field}`) reads a field from **any upstream ancestor**, not just the immediate node — no re-threading through every intermediate schema ([ADR-0051](docs/DECISIONS.md))
- **Schema CRUD** — Create, rename, and delete schemas and fields directly in the UI; references cascade on rename
- **Nested pydantic models** — A schema field's type can be another declared schema (`customer: Customer`); the validator rejects cycles and codegen emits the models in dependency order
![Project Screenshot](https://github.com/neo-fetch/draw-your-agents/blob/main/assets/sc%200.png?raw=true)

### Iterative Refinement — Critic/Reviser Loop
- **Loop node** — A self-contained *generate → critique → revise* loop that iterates until an LLM critic approves (or a max-iteration cap)
- **Compiles to a real dynamic workflow** — On ADK, codegen emits an `@node` orchestrator (`ctx.run_node` + a bounded Python loop) modeled on a verified working example; on LangGraph, the equivalent bounded loop runs inside one node function — either way it's one node, so the outer graph stays an acyclic DAG
- **Typed payloads** — Generator/critic/reviser exchange pydantic-typed I/O (composes with nested schemas); a canonical `{status, feedback}` critic output drives termination
![Project Screenshot](https://github.com/neo-fetch/draw-your-agents/blob/main/assets/sc%201.png?raw=true)

### Code Generation Pipeline
- **Full v1 declarative coverage** — Agent, Function, Router, JoinNode, HumanInput, nested Workflow, and Tool nodes all compile end to end
- **Two targets from one IR** — A single `compile(ir, { target })` emits a **Google ADK** project (default) or a **LangGraph** project (`target: "langgraph"`), via target dispatch at compile time ([ADR-0045 / ADR-0046](docs/DECISIONS.md))
- **Proven against both frameworks** — ADK projects construct successfully against `google-adk==2.0.0` ([ADR-0021](docs/DECISIONS.md)); LangGraph projects build and dry-run against `langgraph` 1.x
- **Golden-file tested** — The codegen output is pinned by golden files **per target** (`golden/` for ADK, `golden-langgraph/` for LangGraph); the validator is the IR spec

### Graph IR — The Single Source of Truth
- **One canonical IR** — Every input (visual builder, draw.io) produces a versioned JSON Graph IR. Validation, codegen, and save/load all operate on the IR — never directly on UI state or XML ([ADR-0001](docs/DECISIONS.md))
- **Recursive** — Nested workflows carry a complete sub-IR in `config.graph`, validated recursively with the same rules
- **Flat global namespace** — Node and schema names are unique across all nesting levels

---

## 🏗 Architecture

```
UI / draw.io  →  IR  →  validator  →  codegen  →  runnable ADK *or* LangGraph project (.zip)
                                          └── target: "adk" (default) | "langgraph"
```

### Code Generation Pipeline (detailed)
```
IR → edges compiler → per-node template fragments → assemble modules
   → import dedupe → format (black) → syntax check → bundle project scaffold
```

### Generated Output (a runnable project, not one file)

**ADK target** (`target: "adk"`, default):
```
my_workflow/
  workflow.py        # root_agent = Workflow(edges=[...])
  agents.py          # Agent(...) with model params + instruction
  functions.py       # function / router / join / humanInput bodies
  loops.py           # @node critic/reviser orchestrators (emitted when loop nodes exist)
  schemas.py         # Pydantic BaseModels for every input/output schema
  main.py            # runnable entrypoint
  requirements.txt   # google-adk==2.0.0
  .env.example
  README.md
```

**LangGraph target** (`target: "langgraph"`):
```
my_workflow/
  graph.py           # StateGraph wiring (nodes, edges, conditional edges, subgraphs)
  state.py           # TypedDict session state — one <node>_output key per node
  agents.py          # node fns: init_chat_model(...).with_structured_output(Schema)
  nodes.py           # function / router / join / humanInput node fns
  loops.py           # bounded generate→critic→revise loop fns (when loop nodes exist)
  schemas.py         # shared Pydantic BaseModels
  main.py            # runnable entrypoint
  test_graph.py      # builds every StateGraph (dry-run import check)
  requirements.txt   # langgraph, langchain, langchain-google-genai
  .env.example
  README.md
```

### Node Taxonomy

| IR `type`     | ADK construct        | LangGraph construct                       | Key config                                       |
|---------------|----------------------|-------------------------------------------|--------------------------------------------------|
| `agent`       | `Agent` / `LlmAgent` | `init_chat_model().with_structured_output()` node fn | model, instruction (structured template), modelParams, mode, tools, schemas |
| `function`    | `def f(node_input)`  | node fn → state update                     | description, inputType, outputType, emits, body   |
| `router`      | fn → `Event(route=)` | node fn + `add_conditional_edges`          | routes[], body; branch targets via edge `route`    |
| `tool`        | `FunctionTool`       | node fn (pipeline step)                    | inputType, outputType, body                       |
| `join`        | `JoinNode`           | node fn with `defer=True`                  | waits for all upstreams                           |
| `humanInput`  | `RequestInput`       | `interrupt()` + `Command(resume=...)`      | message, payloadRef, responseSchemaRef            |
| `workflow`    | nested `Workflow`    | compiled subgraph                          | sub-IR in `config.graph`                          |
| `loop`        | `@node` orchestrator | bounded loop in one node fn                | maxIterations, approvalPhrase, input/payload types, generator + critic + reviser sub-agents |

> **Data flow.** ADK threads each node's `Event(output=...)` to the next node's `node_input` (positional); LangGraph writes every node's output to a shared `state` TypedDict (`<node>_output`). Both honor the same IR: positional prompt chips render `<Schema.field from node>` (ADK) / a state read (LangGraph), and non-adjacent `{Schema.field}` chips read from session state in either target.

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
│   └── codegen/               # IR → ADK + LangGraph project generators
│       ├── src/
│       │   ├── edges.ts       # Edges compiler (linearizes the graph into ADK edge rows)
│       │   ├── fragments.ts   # Per-node ADK template fragments (renderAgent, renderFunction, etc.)
│       │   ├── project.ts     # ADK project assembler (stitches fragments into modules)
│       │   ├── compile.ts     # validate → generateProject entry point (target dispatch)
│       │   ├── langgraph/     # LangGraph target — state.ts, fragments.ts, graphModule.ts, project.ts
│       │   ├── format.ts      # Black formatter integration
│       │   ├── bundle.ts      # Pure-TS STORE-only .zip bundler (browser-compatible)
│       │   └── python.ts      # Python code generation helpers
│       └── test/
│           ├── golden/            # ADK golden-file fixtures (the codegen spec)
│           ├── golden-langgraph/  # LangGraph golden-file fixtures
│           └── *.test.ts          # Edges, project, project-langgraph, compile, format, bundle tests
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
│   ├── DECISIONS.md                   # Append-only ADR log (ADR-0001 onward)
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
# ADK project (default target)
node scripts/compile.ts packages/ir/fixtures/city-time.ir.json city_time.zip

# LangGraph project
node scripts/compile.ts packages/ir/fixtures/city-time.ir.json city_time_langgraph.zip --target=langgraph
```

---

## 🆚 Not a Workflow Runtime (How This Differs from n8n)

People often see a node-graph editor for AI workflows and assume it's "n8n for agents." It isn't — they're different categories of tool. **This project is a compiler; n8n is a runtime.** Graphical Agents takes the graph you draw and emits a standalone, framework-native Python project that *you* own and run on your own infrastructure. n8n keeps your workflow inside its own engine and executes it for you; its "export" is a JSON snapshot of the visual config for moving between n8n instances, not source code you can run independently.

| | Graphical Agents | n8n |
|---|---|---|
| **Category** | Visual → code compiler for agent graphs | Workflow-automation / iPaaS runtime |
| **Output** | Standalone ADK / LangGraph Python project (`.zip`) | Running automations + a JSON config snapshot |
| **Execution** | None — you run the generated code on your infra | n8n's own engine executes everything |
| **Scope** | Multi-agent AI graphs (8 node types) | 400+ app integrations, triggers, ETL, broad automation |
| **Triggers / connectors** | None | Webhooks, cron, polling, 400+ service connectors |
| **Backend** | Browser-only, no server, no account | Self-hosted or cloud server |
| **Lock-in** | Zero after export — the output is plain framework code | Workflows live inside n8n |

In short: n8n answers *"build and operate this automation for me"*; Graphical Agents answers *"draw the agent graph and hand me the source code to run however I want."* Its real peers are tools like LangGraph Studio, Google's ADK tooling, Flowise, and Langflow — and even among those, the **code-export** (rather than run-it-for-you) posture is what sets it apart.

> n8n details above reflect publicly documented behavior as of 2025–2026 and are summarized at a high level for positioning.

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
| `packages/codegen` | IR → ADK **and** LangGraph projects (templates + edges compiler + per-target golden tests) | `packages/ir` (types only) |
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

## 🖤 Why Bathory

![Quorthon](https://images.squarespace-cdn.com/content/v1/59c9b7ead2b857a85063e490/1559530848175-P00RZPJTEQSMGSQZKIYD/Quorthon.jpg)

The dark theme in this builder is called **bathory**, and it isn't just a color choice — it's the reason this project looks, ships, and licenses the way it does.

**Free and browser-only, by design.** Everything runs client-side: validation, code generation, the live preview, even the `.zip` bundler is pure TypeScript executing in your tab. No server, no account, no telemetry, nothing to pay. The project is built to be free for individuals and non-profits, and the [AGPL-3.0 license](#-license) keeps it that way — whoever builds on it must pass the same freedom downstream.

**The theme.** The palette descends from the base16 **"Black Metal (Bathory)"** scheme by metalelf0, whose colors were lifted from the cover art of late-1980s extreme-metal records: near-black paper, bone-white scratch lettering, ash greys, and one violent red. It is deliberately lo-fi and anti-commercial — sharp corners, film grain, CRT scanlines — a rejection of the neon, "vibrant", gamer-centric look of modern UI. See [`bathory.css`](apps/web/src/styles/themes/bathory.css) and ADR-0044 in the [decision log](docs/DECISIONS.md).

**The band.** [Bathory](https://en.wikipedia.org/wiki/Bathory_(band)), led by Quorthon, pioneered the first wave of black metal from Stockholm in the early 1980s. The early occult imagery — inverted crosses, demonic theatrics, abrasive lo-fi production — was provocation aimed squarely at religious dogmatism and institutional authority, not literal belief. By the late '80s Quorthon abandoned the Satanic aesthetic entirely and invented Viking metal: romanticized Norse storytelling about bravery, honor, and heritage, with later albums dwelling on the futility and tragedy of war rather than glorifying it.

**The principles.** Quorthon stood for staunch individualism and anti-authoritarianism. He was openly critical of herd mentality and of every ideology that tries to herd individuals into collectives, and he firmly rejected fascism and every attempt by hate groups to co-opt Norse and pagan imagery for white supremacy or neo-Nazism. Those principles — independence, skepticism of dogma, anti-war, and zero tolerance for hate — are what this project stands for.

*In memory of Quorthon (Tomas "Ace" Börje Forsberg, 1966–2004).*

---

## 📝 Key ADK Facts the Generator Relies On

- `Workflow(edges=[...])` where a row is a sequence chain; `("START", ...)` begins a graph; START may repeat (parallel fan-out)
- Router: a function returns `Event(route=...)` → a row `(router, {route: target})`
- Data flow is **positional**: `Event(output=...)` → next node's `node_input`. **One output per node.**
- Agent prompt variables: positional chips emit the source-bound form `<Schema.field from node_name>`; non-adjacent chips emit the session form `{Schema.field}`
- `JoinNode` waits for all upstreams; every upstream needs a failsafe output or it hangs
- HumanInput = `RequestInput(message, payload?, response_schema?)`

## 🔗 How the Same IR Maps to LangGraph

- **Shared state, not positional piping** — a `TypedDict` carries one `<node>_output` key per node, plus `workflow_input`; no two nodes (parallel branches included) write the same key, so no reducers are needed
- **Agents** → lazy `init_chat_model(...)` + `.with_structured_output(Schema)`; **routers** → `add_conditional_edges`; **joins** → a node registered with `defer=True` (LangGraph needs no failsafe outputs)
- **HumanInput** → `interrupt()` paused on a checkpointer, resumed with `Command(resume=...)`; **loop** nodes → a bounded Python loop inside one node function
- **Nested workflows** → compiled subgraphs wired into the parent's state
- See [ADR-0045 / ADR-0046](docs/DECISIONS.md) for the full target design

---

## 📄 Documentation

- [Architecture Blueprint](docs/ARCHITECTURE.md) — Full system design
- [Decision Log (ADRs)](docs/DECISIONS.md) — Append-only architectural decision records (ADR-0001 onward; LangGraph target: ADR-0045 / ADR-0046)
- [IR Schema Contract](docs/IR-SCHEMA.md) — Graph IR format specification
- [Phase 2 Design](docs/PHASE-2-DESIGN.md) — Variable-chip system design & slice plan
- [Nested Schemas Design](docs/PHASE-NESTED-SCHEMAS-DESIGN.md) — Nested pydantic models design & slice plan
- [Loop Node Design](docs/PHASE-SUBAGENTS-DESIGN.md) — Critic/reviser loop (dynamic workflow) design & slice plan

---

## 📜 License

[GNU Affero General Public License v3.0](LICENSE)
