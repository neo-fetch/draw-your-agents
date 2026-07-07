# E2E Execution Findings

> **Status: all five findings (F1–F5) are FIXED** — see the
> [re-run after fixes](#re-run-after-fixes-4444) at the bottom: 44/44 cells
> pass, and freshly generated projects run under `adk run` as shipped
> (ADR-0053). The matrix and finding entries below are preserved as the record
> of the *first* run.

First full run of the tier-3 e2e harness (`npm run test:e2e:live`, ADR-0052):
every IR fixture compiled for both targets, generated projects installed and
executed against the **real** libraries, live subset run with a real Google AI
Studio (free-tier) key on 2026-07-07.

Environment: Python 3.11.15 · `google-adk==2.0.0` · `google-genai==1.75.0` ·
`langgraph==1.2.8` · `langchain==1.3.11` · `langchain-google-genai==4.2.7` ·
`pydantic==2.13.4`. `black` was not installed, so the format stage degraded to
`status: "unavailable"` (expected posture, ADR-0003); execution is unaffected.

## Result matrix (44 cells: 41 ok, 3 fail)

| fixture | adk-dry | adk-live | langgraph-dry | langgraph-live |
|---|---|---|---|---|
| city-time | ✅ pass | ✅ pass | ✅ pass | ✅ pass |
| critic-loop | ✅ pass | ⏭ skip¹ | ✅ pass | ⏭ skip¹ |
| human-input | ✅ pass | ⏭ skip² | ✅ pass | ⏭ skip² |
| nested | ✅ pass | ⏭ skip³ | ✅ pass | ⏭ skip³ |
| nested-schema | ✅ pass | ⏭ skip³ | ✅ pass | ⏭ skip³ |
| parallel | ✅ pass | ❌ **F2** | ✅ pass | ✅ pass |
| parallel-mid | ✅ pass | ⏭ skip³ | ✅ pass | ⏭ skip³ |
| routing | ✅ pass | ✅ pass | ✅ pass | ✅ pass |
| showcase-all-nodes | ❌ **F1** | ⏭ skip | ✅ pass | ⏭ skip |
| state-vars | ✅ pass | ⏭ skip³ | ✅ pass | ⏭ skip³ |
| tool | ✅ pass | ❌ **F3** | ✅ pass | ✅ pass |

¹ gemini-2.5-pro on free tier · ² interactive stdin (`RequestInput`) ·
³ not in live subset (rate limits)

**Headline:** the feared wholesale API mismatch did **not** happen —
`Workflow(edges=…)`, `Agent`, `Event`, `JoinNode`, `FunctionTool`,
`RequestInput`, `Runner` all exist in google-adk 2.0.0 and every graph shape
constructs. The LangGraph target is fully green, dry **and** live. Live runs
produced real model output (city generation, correct LOGISTICS routing,
faithful article summaries); no 429s with 20 s pacing.

## Findings

### F1 — ADK: `modelParams` emitted as bare `Agent` kwargs are rejected
- **Cell:** `adk/showcase-all-nodes` (dry). Only fixture using `modelParams`.
- **Symptom:** `pydantic ValidationError: 4 validation errors for LlmAgent —
  temperature / top_p / top_k / max_output_tokens: Extra inputs are not
  permitted [extra_forbidden]` at `agents.py` import.
- **Cause:** codegen renders IR `modelParams` as snake_case kwargs directly on
  `Agent(...)` (`packages/codegen/src/fragments.ts`, modelParams rendering
  next to `model=`), but real `LlmAgent` is a closed pydantic model — sampling
  params belong in `generate_content_config=types.GenerateContentConfig(...)`.
- **Fix direction:** emit `generate_content_config` from `modelParams`;
  goldens for `showcase-all-nodes`-style agents change accordingly.

### F2 — ADK: function after a `JoinNode` is typed `str` but receives a dict
- **Cell:** `adk/parallel` (live; dry passes because construction never binds
  inputs).
- **Symptom:** `pydantic ValidationError: Input should be a valid string —
  input_value={'task_b': 'task_b done (…)', …}` from ADK's
  `_function_node._bind_parameters` when `final_task_d(node_input: str)` runs.
- **Cause:** `JoinNode` hands its downstream node a **dict of upstream
  outputs**, but codegen annotates every function's `node_input` from the
  single-output rail as `str` (`packages/codegen/src/fragments.ts` function
  signature emission). ADK 2.0 coerces parameters against the annotation via
  pydantic, so the run dies before the function body executes.
- **Fix direction:** when a function's upstream is a join, annotate
  `node_input: dict` (or a generated TypedDict of branch outputs).
  Note the LangGraph target already models this correctly (explicit
  `my_join_node` merge dict in `nodes.py`) — parity bug, ADK side only.

### F3 — ADK: `FunctionTool` used as a graph node rejects message input
- **Cell:** `adk/tool` (live).
- **Symptom:** `TypeError: The input to ToolNode must be a dictionary of tool
  arguments or None, but got <class 'google.genai.types.Content'>` when the
  workflow starts at `("START", fetch_data, summarize)`.
- **Cause:** codegen wraps the IR tool node as
  `fetch_data = FunctionTool(func=fetch_data_impl)` and places it directly in
  the edge row (`workflow.py`). In real ADK 2.0, a tool node in the graph is a
  `ToolNode` that expects **tool-call arguments (a dict)**, not the incoming
  user `Content` — tools are meant to be invoked by an agent (via
  `Agent(tools=[…])`) or fed structured args, not to head a row from START.
- **Fix direction:** either emit a plain function node for graph-positioned
  tool work, or attach the tool to the downstream agent as `tools=[…]` and
  drop it from the edge row; needs an IR-level decision on what a `tool` node
  in the drawn graph *means*.

### F4 — LangGraph: agent output stored as content-block list, not text (soft)
- **Cell:** `langgraph/city-time` (live — run *passes*, output is degraded).
- **Symptom:** state keys typed `str` (e.g. `city_generator_output`) actually
  hold `[{'type': 'text', 'text': 'Tokyo', 'extras': {'signature': …}}]`;
  downstream f-string prompts interpolate the whole block dump, so the final
  report reads `It is 12:00 PM in [{'type': 'text', 'text': 'Tokyo', …}] right
  now.`
- **Cause:** generated agent nodes return `result.content`
  (`packages/codegen/src/langgraph/fragments.ts`, agent template — see
  `golden-langgraph/*/agents.py`). Under langchain 1.x +
  `langchain-google-genai` 4.x, `.content` is a list of content blocks (with
  thinking signatures); the plain-text accessor is `result.text`.
- **Fix direction:** emit `result.text` (or normalize blocks to text) in the
  agent fragment; goldens update mechanically.

### F5 — ADK: generated projects are not `adk run` compatible as shipped
- **Cell:** manual `adk run` check on the staged `city-time` project
  (google-adk 2.0.0 CLI).
- **Symptom:** `adk run <project_dir> "…"` fails at the agent loader: it
  requires the folder to expose `root_agent` via `agent.py`, `__init__.py`,
  or `root_agent.yaml` — but codegen defines `root_agent` in `workflow.py`.
  The generated README's "`adk run workflow.py`" is doubly wrong: the CLI
  takes an agent *folder*, not a file, and the folder name must be a valid
  Python identifier (zips are prefixed with `ir.name`, e.g.
  `city_time_workflow`, so shipped layout is safe on that count).
- **Verified fix:** a one-line shim `agent.py` containing
  `from workflow import root_agent` makes the CLI work completely — a full
  live run through the whole graph produced
  `[city_generator]: "Kyoto"` → `[city_report]: "It is 12:00 PM in Kyoto
  right now."` → `[city_time_workflow]: [workflow complete] …`.
- **Fix direction:** emit `agent.py` (the shim) in the ADK scaffold
  (`packages/codegen/src/project.ts` `BASE_FILES`) and correct the README
  template's `adk run` / `adk web` instructions to
  `adk run <parent_dir>/<project_name>`; golden file-sets gain one file.

## Verification pointers

- Reproduce dry matrix: `npm run test:e2e` (network for pip; no key).
- Reproduce live: `GOOGLE_API_KEY=… npm run test:e2e:live`.
- Raw per-cell logs land in `.e2e-work/logs/`; machine-readable results in
  `.e2e-work/report.json`.

## Re-run after fixes (44/44)

All five findings were fixed in codegen (ADR-0053; commit `8b29c35`) and the
full harness re-run the same day came back completely green:

| fixture | adk-dry | adk-live | langgraph-dry | langgraph-live |
|---|---|---|---|---|
| city-time | ✅ | ✅ | ✅ | ✅ |
| critic-loop | ✅ | ⏭ | ✅ | ⏭ |
| human-input | ✅ | ⏭ | ✅ | ⏭ |
| nested | ✅ | ⏭ | ✅ | ⏭ |
| nested-schema | ✅ | ⏭ | ✅ | ⏭ |
| parallel | ✅ | ✅ | ✅ | ✅ |
| parallel-mid | ✅ | ⏭ | ✅ | ⏭ |
| routing | ✅ | ✅ | ✅ | ✅ |
| showcase-all-nodes | ✅ | ⏭ | ✅ | ⏭ |
| state-vars | ✅ | ⏭ | ✅ | ⏭ |
| tool | ✅ | ✅ | ✅ | ✅ |

Spot checks beyond the matrix:

- **F4:** the LangGraph `city-time` live final state is now clean text —
  `'city_generator_output': 'Tokyo'`, final report
  `It is 12:00 PM in Tokyo right now.` — no content-block dumps.
- **F5:** a freshly generated project (no manual edits) loads under
  `adk run city_time_workflow "…"` via the emitted `agent.py` shim and
  executes with real model calls. (Later same-day CLI repeats hit the AI
  Studio free-tier daily quota — 429 `RESOURCE_EXHAUSTED`, limit 20/day per
  model — which is a key-tier constraint, not a codegen issue.)

Per-finding fixes (all in commit `8b29c35`):

| Finding | Fix |
|---|---|
| F1 | `modelParams` → `generate_content_config=types.GenerateContentConfig(...)` (`fragments.ts`) |
| F2 | join-fed functions/routers/tools annotate `node_input: dict` (`project.ts` `joinFedNodeIds` + fragments) |
| F3 | graph-positioned tools emit as plain functions named after the node; `FunctionTool` wrapper removed |
| F4 | LangGraph agents return `result.text` instead of `result.content` |
| F5 | every ADK project ships `agent.py` (`from workflow import root_agent`); README run instructions corrected |
