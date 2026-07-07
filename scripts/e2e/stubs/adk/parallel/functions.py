# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from google.adk import Event


def task_a(node_input: str) -> Event:
    """Parallel branch A."""
    return Event(output=f"task_a done ({node_input})")


def task_b(node_input: str) -> Event:
    """Parallel branch B."""
    return Event(output=f"task_b done ({node_input})")


def task_c(node_input: str) -> Event:
    """Parallel branch C."""
    return Event(output=f"task_c done ({node_input})")


def final_task_d(node_input: str) -> Event:
    """Final task after the join."""
    return Event(output=f"combined after join: {node_input}")
