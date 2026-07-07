# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from schemas import CityTime
from state import WorkflowState


def lookup_time(state: WorkflowState) -> dict:
    """Return the current time in the given city."""
    node_input = state["city_generator_output"]
    output = CityTime(time_info="12:00 PM", city=str(node_input).strip())
    return {"lookup_time_output": output}


def completed_message(state: WorkflowState) -> dict:
    """Append a workflow-completed notice to the report."""
    node_input = state["city_report_output"]
    output = f"[workflow complete] {node_input}"
    return {"completed_message_output": output}
