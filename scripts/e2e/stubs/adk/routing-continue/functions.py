# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from google.adk import Event

# What actually executed, in order. `main.py` reads this to decide whether ADK
# traversed the router's branch continuation — the whole point of this cell
# (ADR-0054). Same process, so a plain module global is enough.
EXECUTED: list[str] = []

# A token no LLM would emit on its own, so main.py can tell the raw report apart
# from summarize_result's rewrite of it.
TEST_REPORT = "E2E_RUN_TESTS_SENTINEL: 12 passed, 1 failed (test_retry_backoff)"


def feasibility_router(node_input: str) -> Event:
    """Decide whether the assessed request is feasible to build now."""
    EXECUTED.append("feasibility_router")
    # Deliberately defaults to FEASIBLE: that is the branch carrying the
    # continuation (generate_code -> run_tests -> summarize_result), and this
    # cell exists to exercise it. INFEASIBLE is reachable only on an explicit
    # blocker word, so a surprising assessment from the live model cannot
    # quietly route us down the terminal branch and turn this into a no-op pass.
    text = str(node_input).lower()
    if any(w in text for w in ("impossible", "cannot", "infeasible", "blocked")):
        route = "INFEASIBLE"
    else:
        route = "FEASIBLE"
    return Event(route=route)


def run_tests(node_input: str) -> Event:
    """Run the project's test suite against the generated code and return the report."""
    EXECUTED.append("run_tests")
    return Event(output=TEST_REPORT)
