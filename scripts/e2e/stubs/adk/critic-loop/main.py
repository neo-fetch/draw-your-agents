# Live e2e stub for critic-loop (ADR-0059): seed the loop's spec, run once, and
# FAIL unless a loop sub-agent actually called the `check_python_syntax` library
# tool and the loop wrote a validated payload.

import asyncio
import sys
from uuid import uuid4

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

import agent_tools
from workflow import root_agent

APP_NAME = "critic_loop_workflow"
USER_ID = "user"
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


async def main() -> None:
    session_service = InMemorySessionService()
    session_id = f"run-{uuid4().hex[:8]}"
    await session_service.create_session(
        app_name=APP_NAME,
        user_id=USER_ID,
        session_id=session_id,
        state={"code_loop_input": SPEC},
    )
    runner = Runner(
        agent=root_agent, app_name=APP_NAME, session_service=session_service
    )
    async for event in runner.run_async(
        user_id=USER_ID,
        session_id=session_id,
        new_message=types.Content(role="user", parts=[types.Part(text=SPEC)]),
    ):
        for part in (event.content.parts if event.content else None) or []:
            if part.function_call:
                print("function_call:", part.function_call.name)
    final_session = await session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    )
    state = final_session.state if final_session else {}
    print("check_python_syntax results:", CALLS)
    print("code_loop_output:", state.get("code_loop_output"))
    if not CALLS:
        sys.exit("FAIL: no loop sub-agent called check_python_syntax")
    if not state.get("code_loop_output"):
        sys.exit("FAIL: the loop wrote no code_loop_output")


if __name__ == "__main__":
    asyncio.run(main())
