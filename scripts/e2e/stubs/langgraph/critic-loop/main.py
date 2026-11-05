# Live e2e stub for critic-loop (ADR-0059): run once with a real spec and FAIL
# unless a loop sub-agent actually called the `check_python_syntax` library
# tool and the loop returned a validated payload.

import sys

import agent_tools
from graph import graph

SPEC = (
    "Write one Python file named fizzbuzz.py defining fizzbuzz(n: int) -> list[str] "
    "that returns the FizzBuzz sequence for 1..n."
)

# Count real tool executions: the public tool resolves `_check_python_syntax_impl`
# from module globals at call time, so wrapping it here sees every call.
CALLS: list[str] = []
_impl = agent_tools._check_python_syntax_impl


def _counting_impl(code: str) -> str:
    result = _impl(code)
    CALLS.append(result)
    return result


agent_tools._check_python_syntax_impl = _counting_impl


def main() -> None:
    result = graph.invoke({"workflow_input": SPEC})
    print("check_python_syntax results:", CALLS)
    print("code_loop_output:", result.get("code_loop_output"))
    if not CALLS:
        sys.exit("FAIL: no loop sub-agent called check_python_syntax")
    if result.get("code_loop_output") is None:
        sys.exit("FAIL: the loop returned no code_loop_output")


if __name__ == "__main__":
    main()
