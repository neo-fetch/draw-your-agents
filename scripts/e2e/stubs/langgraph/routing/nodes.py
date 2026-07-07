# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from state import WorkflowState


def router(state: WorkflowState) -> dict:
    """Route the support message to the matching handler."""
    node_input = state["process_message_output"]
    text = str(node_input).lower()
    if any(w in text for w in ("bug", "crash", "error", "broken")):
        route = "BUG"
    elif any(w in text for w in ("ship", "deliver", "package", "tracking", "transit")):
        route = "LOGISTICS"
    else:
        route = "CUSTOMER_SUPPORT"
    return {"router_output": route}
