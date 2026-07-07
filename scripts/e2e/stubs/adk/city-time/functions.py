# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from google.adk import Event

from schemas import CityTime


def lookup_time(node_input: str) -> Event:
    """Return the current time in the given city."""
    output = CityTime(time_info="12:00 PM", city=str(node_input).strip())
    return Event(output=output)


def completed_message(node_input: str) -> Event:
    """Append a workflow-completed notice to the report."""
    message = f"[workflow complete] {node_input}"
    return Event(message=message)
