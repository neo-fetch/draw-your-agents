# E2E stub overlay — deterministic implementation of the generated TODO stubs.
# Copied over the staged project by scripts/e2e.ts --live (see ../../README.md).

from schemas import Article
from state import WorkflowState


def fetch_data(state: WorkflowState) -> dict:
    """Fetch an article from a remote source."""
    output = Article(
        title="The Quiet Turbine",
        body=(
            "Engineers this week unveiled a bladeless wind turbine that produces "
            "power in near silence. The prototype survived storm-force winds and "
            "is expected to enter field trials next spring."
        ),
    )
    return {"fetch_data_output": output}
