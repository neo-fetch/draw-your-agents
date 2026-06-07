import asyncio
import logging
from typing import Any, cast
from uuid import uuid4

from pydantic import BaseModel, Field

from google.adk import Context, Workflow
from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.workflow import START, node
from google.genai import types

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants & Configuration
# ---------------------------------------------------------------------------
MODEL_ID = "gemini-2.5-flash"
ADVANCED_MODEL_ID = "gemini-2.5-pro" # Often used for the reviser to fix complex errors
APP_LABEL = "generic_generate_validate_loop"
SYSTEM_USER_ID = "system"

MAX_VALIDATION_RETRIES = 5
CRITIC_APPROVAL_PHRASE = "APPROVED"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class FileItem(BaseModel):
    filename: str = Field(description="Name of the file.")
    content: str = Field(description="Source code or content of the file.")

class GenerationOutputSchema(BaseModel):
    files: list[FileItem] = Field(description="List of generated files.")

class CriticOutputSchema(BaseModel):
    status: str = Field(description=f"Must be '{CRITIC_APPROVAL_PHRASE}' if perfect, otherwise 'REJECTED'.")
    feedback: str = Field(description="Detailed feedback on what needs to be fixed.")

class GeneratorInputSchema(BaseModel):
    specifications: str

class CriticInputSchema(BaseModel):
    current_files: GenerationOutputSchema
    specifications: str

class ReviserInputSchema(BaseModel):
    current_files: GenerationOutputSchema
    revision_feedback: str
    feedback_source: str


# ---------------------------------------------------------------------------
# Mock External / Deterministic Actions
# ---------------------------------------------------------------------------
def run_deterministic_compile_test(files: list[FileItem]) -> tuple[bool, str]:
    """
    Mock function representing an external compiler, linter, or test runner.
    Returns a tuple of (Success_Boolean, Error_Output_String).
    """
    logger.info("Running deterministic compile/test suite...")
    # In a real scenario: write files to a temp dir and run `subprocess.run(["make", "test"])`
    
    # Mocking a successful compile for demonstration
    return True, ""

def save_accepted_output(files: list[FileItem], output_dir: str):
    """Mock function to save the final validated output."""
    logger.info(f"Saving {len(files)} validated files to {output_dir}")


# ---------------------------------------------------------------------------
# Agent Definitions
# ---------------------------------------------------------------------------
def build_generator_agent() -> LlmAgent:
    return LlmAgent(
        model=MODEL_ID,
        name="Generator",
        instruction="You are an expert developer. Generate code based on the provided specifications.",
        input_schema=GeneratorInputSchema,
        output_schema=GenerationOutputSchema,
        output_key="generated_files",
    )

def build_critic_agent() -> LlmAgent:
    return LlmAgent(
        model=MODEL_ID,
        name="Critic",
        instruction=(
            f"Review the code against the specifications. "
            f"If it meets all requirements, return status '{CRITIC_APPROVAL_PHRASE}'. "
            f"Otherwise, return detailed feedback."
        ),
        input_schema=CriticInputSchema,
        output_schema=CriticOutputSchema,
        output_key="critic_feedback",
    )

def build_reviser_agent() -> LlmAgent:
    return LlmAgent(
        model=ADVANCED_MODEL_ID,
        name="Reviser",
        instruction="Fix the provided code based on the compilation errors and critic feedback.",
        input_schema=ReviserInputSchema,
        output_schema=GenerationOutputSchema,
        output_key="revised_files",
    )

# Helper to cast ADK raw output to Pydantic models
def validate_node_output(schema_cls: type[BaseModel], raw_output: Any) -> BaseModel:
    if isinstance(raw_output, schema_cls):
        return raw_output
    if isinstance(raw_output, dict):
        return schema_cls.model_validate(raw_output)
    if isinstance(raw_output, BaseModel):
        return schema_cls.model_validate(raw_output.model_dump())
    raise ValueError(f"Cannot validate {type(raw_output)} into {schema_cls}")


# ---------------------------------------------------------------------------
# Core Workflow Orchestrator
# ---------------------------------------------------------------------------
@node(rerun_on_resume=True)
async def generation_validation_orchestrator(ctx: Context):
    # 1. Setup Agents
    generator_agent = build_generator_agent()
    critic_agent = build_critic_agent()
    reviser_agent = build_reviser_agent()
    
    specs = ctx.state.get("specifications", "Default spec...")

    # 2. Step One: Initial Generation
    logger.info("Starting Generation Phase")
    generator_input = GeneratorInputSchema(specifications=specs)
    generated_raw = await ctx.run_node(generator_agent, generator_input)
    current_files = cast(GenerationOutputSchema, validate_node_output(GenerationOutputSchema, generated_raw))

    # 3. Step Two: The Validation Loop (Critic + Compile -> Revise)
    for review_round in range(MAX_VALIDATION_RETRIES):
        logger.info(f"--- Starting Validation Round {review_round + 1} ---")
        
        # Action A: LLM Critic Review
        critic_input = CriticInputSchema(current_files=current_files, specifications=specs)
        critic_raw = await ctx.run_node(critic_agent, critic_input)
        critic_result = cast(CriticOutputSchema, validate_node_output(CriticOutputSchema, critic_raw))
        critic_ok = (critic_result.status == CRITIC_APPROVAL_PHRASE)
        logger.info(f"Critic Status: {critic_result.status}")

        # Action B: Deterministic Compile/Test
        compile_ok, compile_errors = run_deterministic_compile_test(current_files.files)
        logger.info(f"Compile Status: {'SUCCESS' if compile_ok else 'FAILED'}")

        # Action C: Check Success Criteria
        if critic_ok and compile_ok:
            logger.info(f"Success! Output validated on round {review_round + 1}")
            save_accepted_output(current_files.files, "/final/output/path")
            ctx.state["final_files"] = [f.model_dump() for f in current_files.files]
            return

        # Action D: Combine Feedback for Revision
        feedback_parts = []
        if not critic_ok:
            feedback_parts.append(f"CRITIC FEEDBACK:\n{critic_result.feedback}")
        if not compile_ok:
            feedback_parts.append(f"COMPILE ERRORS:\n{compile_errors}")
            
        combined_feedback = "\n\n".join(feedback_parts)
        feedback_source = "critic_and_compile" if (not critic_ok and not compile_ok) else ("critic" if not critic_ok else "compile")

        logger.warning(f"Round {review_round + 1} failed. Sending to reviser. Source: {feedback_source}")

        # Action E: Revise Output
        reviser_input = ReviserInputSchema(
            current_files=current_files,
            revision_feedback=combined_feedback,
            feedback_source=feedback_source,
        )
        revised_raw = await ctx.run_node(reviser_agent, reviser_input)
        current_files = cast(GenerationOutputSchema, validate_node_output(GenerationOutputSchema, revised_raw))

    # If loop exhausts without breaking:
    raise RuntimeError(f"Workflow failed to produce valid output after {MAX_VALIDATION_RETRIES} rounds.")


# ---------------------------------------------------------------------------
# Execution Wrapper
# ---------------------------------------------------------------------------
def create_workflow() -> Workflow:
    return Workflow(name="Generate_Validate_Revise", edges=[(START, generation_validation_orchestrator)])

async def run_workflow_async(specifications: str) -> dict[str, Any]:
    session_service = InMemorySessionService()
    session_id = f"workflow-{uuid4().hex[:8]}"

    # Initialize state
    await session_service.create_session(
        app_name=APP_LABEL,
        user_id=SYSTEM_USER_ID,
        session_id=session_id,
        state={"specifications": specifications},
    )

    workflow = create_workflow()
    runner = Runner(agent=cast(Any, workflow), app_name=APP_LABEL, session_service=session_service)
    
    # Run loop
    async for _ in runner.run_async(
        user_id=SYSTEM_USER_ID,
        session_id=session_id,
        new_message=types.Content(role="user", parts=[types.Part(text="Start workflow")]),
    ):
        pass

    # Retrieve final state
    final_session = await session_service.get_session(app_name=APP_LABEL, user_id=SYSTEM_USER_ID, session_id=session_id)
    return final_session.state if final_session else {}

if __name__ == "__main__":
    # Example Usage
    result = asyncio.run(run_workflow_async("Create a Python script that calculates the Fibonacci sequence."))
    print("Workflow complete! Output state:", result)
