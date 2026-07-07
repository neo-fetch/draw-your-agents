# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from state import WorkflowState


def task_a(state: WorkflowState) -> dict:
    """Parallel branch A."""
    node_input = state["workflow_input"]
    return {"task_a_output": f"task_a done ({node_input})"}


def task_b(state: WorkflowState) -> dict:
    """Parallel branch B."""
    node_input = state["workflow_input"]
    return {"task_b_output": f"task_b done ({node_input})"}


def task_c(state: WorkflowState) -> dict:
    """Parallel branch C."""
    node_input = state["workflow_input"]
    return {"task_c_output": f"task_c done ({node_input})"}


def my_join_node(state: WorkflowState) -> dict:
    """Wait for all parallel branches to complete."""
    return {
        "my_join_node_output": {
            "task_a": state["task_a_output"],
            "task_b": state["task_b_output"],
            "task_c": state["task_c_output"],
        }
    }


def final_task_d(state: WorkflowState) -> dict:
    """Final task after the join."""
    node_input = state["my_join_node_output"]
    return {"final_task_d_output": f"combined after join: {node_input}"}
