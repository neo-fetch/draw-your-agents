# E2E stub overlays

Full-file overlays applied by `scripts/e2e.ts --live` on top of a freshly
staged generated project, per live fixture: every file in
`stubs/<target>/<fixture>/` is copied verbatim over
`.e2e-work/projects/<target>/<fixture>/` before `python main.py` runs.

Contents per fixture:

- `functions.py` (ADK) / `nodes.py` (LangGraph) — deterministic
  implementations of the generated `TODO` stubs: hardcoded values, no
  network, no clock, no randomness. LLM **agent** nodes are *not* stubbed —
  they call Gemini for real; that is the point of the live phase.
- `main.py` — a copy of the golden `main.py` with only `SAMPLE_INPUT`
  replaced by a real prompt.

## Overlay contract / drift

Overlays are full files, not patches. When codegen changes the shape of the
files it emits (function signatures, state keys, imports), these overlays go
stale and the live run fails loudly — that failure is the drift detector.
Re-sync by regenerating: copy the new golden file and re-apply the minimal
stub edits. Overlaid projects must still pass their generated dry-run pytest
(`test_workflow.py` / `test_graph.py`).

Only fixtures in `LIVE_SUBSET` (see `scripts/e2e.ts`) have overlay
directories; adding a fixture to the live subset means authoring its overlay
here for both targets.
