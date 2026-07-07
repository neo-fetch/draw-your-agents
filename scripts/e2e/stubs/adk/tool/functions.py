# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from google.adk import Event

from schemas import Article


def fetch_data_impl(node_input: str) -> Event:
    """Fetch an article from a remote source."""
    output = Article(
        title="The Quiet Turbine",
        body=(
            "Engineers this week unveiled a bladeless wind turbine that produces "
            "power in near silence. The prototype survived storm-force winds and "
            "is expected to enter field trials next spring."
        ),
    )
    return Event(output=output)
