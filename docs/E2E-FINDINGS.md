# E2E Execution Findings

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

## Verification pointers

- Reproduce dry matrix: `npm run test:e2e` (network for pip; no key).
- Reproduce live: `GOOGLE_API_KEY=… npm run test:e2e:live`.
- Raw per-cell logs land in `.e2e-work/logs/`; machine-readable results in
  `.e2e-work/report.json`.

Fixes for F1–F4 are follow-up slices (each moves goldens, the codegen spec);
this document plus the harness is the deliverable of the testing slice.
