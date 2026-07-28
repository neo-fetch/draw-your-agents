# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from state import WorkflowState

# A token no LLM would emit on its own, so main.py can tell the raw report apart
# from summarize_result's rewrite of it.
TEST_REPORT = "E2E_RUN_TESTS_SENTINEL: 12 passed, 1 failed (test_retry_backoff)"


def feasibility_router(state: WorkflowState) -> dict:
    """Decide whether the assessed request is feasible to build now."""
    node_input = state["assess_request_output"]
    # Deliberately defaults to FEASIBLE: that is the branch carrying the
    # continuation (generate_code -> run_tests -> summarize_result), and this
    # cell exists to exercise it. Mirrors the ADK overlay so both targets take
    # the same path.
    text = str(node_input).lower()
    if any(w in text for w in ("impossible", "cannot", "infeasible", "blocked")):
        route = "INFEASIBLE"
    else:
        route = "FEASIBLE"
    return {"feasibility_router_output": route}


def run_tests(state: WorkflowState) -> dict:
    """Run the project's test suite against the generated code and return the report."""
    node_input = state["generate_code_output"]
    return {"run_tests_output": TEST_REPORT}
