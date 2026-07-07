# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from google.adk import Event


def router(node_input: str) -> Event:
    """Route the support message to the matching handler."""
    text = str(node_input).lower()
    if any(w in text for w in ("bug", "crash", "error", "broken")):
        route = "BUG"
    elif any(w in text for w in ("ship", "deliver", "package", "tracking", "transit")):
        route = "LOGISTICS"
    else:
        route = "CUSTOMER_SUPPORT"
    return Event(route=route)
