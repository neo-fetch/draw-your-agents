/**
 * LangGraph target — per-node template fragments (ADR-0045/0046). Same
 * Fragment contract as the ADK fragments: pure functions IR-node → { imports,
 * code }; the assembler dedupes imports and stitches modules. Emission is
 * black-shaped (verified idempotent), since `black` is the post-process
 * formatter (ADR-0003).
 *
 * Every node renders as a LangGraph node function `def <name>(state) -> dict`
 * returning a partial state update `{"<name>_output": ...}` (ADR-0046):
 * - agent      → lazy `init_chat_model(...)` (+ `.with_structured_output`)
 * - function   → TODO stub (the IR's `emits: "message"` has no analog; ignored)
 * - tool       → TODO stub (a pipeline step, same shape as function)
 * - router     → TODO stub returning the route label (wired via
 *                `add_conditional_edges` by graphModule.ts)
 * - humanInput → `interrupt(...)`; the resume value is the output, validated
 *                against `responseSchemaRef` in-node (interrupt has no native
 *                response schema)
 * - join       → merges its upstream keys into one dict (registered with
 *                `defer=True` by graphModule.ts)
 * - loop       → a plain while-loop over three structured-output models
 */
import type {
  AgentNode,
  FunctionNode,
  GraphNode,
  HumanInputNode,
  InstructionSegment,
  JoinNode,
  LoopNode,
  ModelParams,
  RouterNode,
  SchemaDef,
  ToolNode,
  TypeRef,
} from "@graphical-agents/ir";
import { resolveRef, type Fragment } from "../fragments.ts";
import { BLACK_LINE_WIDTH, CodegenError, indent, pyStr, type ImportReq } from "../python.ts";
import { outputKey } from "./state.ts";

/**
 * `init_chat_model` model id (ADR-0046): a bare ADK-style id gets the
 * `google_genai:` provider prefix; an id that already carries a
 * `provider:` prefix passes through verbatim.
 */
export function lgModelId(model: string): string {
  return model.includes(":") ? model : `google_genai:${model}`;
}

/** Escape literal text for the body of a double-quoted Python f-string. */
function fstrEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\{/g, "{{")
    .replace(/\}/g, "}}");
}

/**
 * The f-string expression that reads a state key. Single quotes inside the
 * double-quoted f-string (pre-3.12 nesting rules); schema-typed values
 * interpolate as JSON via `.model_dump_json()`.
 */
function fstrStateExpr(
  key: string,
  ref: TypeRef,
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const suffix = schemas.has(ref) ? ".model_dump_json()" : "";
  return `state['${key}']${suffix}`;
}

/**
 * `<target> = <literal>` at `indentLevel`, paren-wrapped exactly when black
 * would: the inline form overflows but the literal fits one indent deeper.
 * (Black never splits string literals, so longer lines stay as-is.)
 */
function strAssign(target: string, literal: string, indentLevel: number): string {
  const pad = "    ".repeat(indentLevel);
  const inline = `${pad}${target} = ${literal}`;
  if (inline.length <= BLACK_LINE_WIDTH) return inline;
  if (pad.length + 4 + literal.length <= BLACK_LINE_WIDTH) {
    return `${pad}${target} = (\n${pad}    ${literal}\n${pad})`;
  }
  return inline;
}

/** A non-null IR `body` is ADK-flavored (`node_input` / `Event(...)`) — reject loud. */
function rejectBody(node: FunctionNode | RouterNode | ToolNode): void {
  if (node.config.body != null) {
    throw new CodegenError(
      `node "${node.name}": IR function bodies target the ADK Event API and ` +
        `cannot be transplanted into a LangGraph project — leave body null`,
    );
  }
}

/**
 * The prompt assignment for an agent-style node. Var segments pull their data
 * from the producing node's state key; an instruction with **no** var segments
 * gets the node's input appended as an `Input:` block (matching ADK's
 * positional semantics, where the upstream output arrives as `node_input`).
 */
function renderPromptAssign(
  segments: readonly InstructionSegment[],
  inputKey: string,
  inputRef: TypeRef,
  schemas: ReadonlyMap<string, SchemaDef>,
): string {
  const hasVars = segments.some((seg) => seg.type === "var");
  const text = segments
    .map((seg) =>
      seg.type === "text"
        ? fstrEscape(seg.value)
        : `{state['${seg.source}_output'].${seg.field}}`,
    )
    .join("");
  const literal = hasVars
    ? `f"${text}"`
    : `f"${text}\\n\\nInput:\\n{${fstrStateExpr(inputKey, inputRef, schemas)}}"`;
  return strAssign("prompt", literal, 1);
}

/** `init_chat_model(...)` call — exploded with a magic trailing comma when it has params. */
function renderModelCall(model: string, params: ModelParams | undefined): string {
  const id = pyStr(lgModelId(model));
  const map: [keyof ModelParams, string][] = [
    ["temperature", "temperature"],
    ["topP", "top_p"],
    ["topK", "top_k"],
    ["maxOutputTokens", "max_output_tokens"],
  ];
  const kwargs = map
    .filter(([key]) => params?.[key] !== undefined)
    .map(([key, py]) => `${py}=${params![key]},`);
  if (kwargs.length === 0) return `init_chat_model(${id})`;
  return `init_chat_model(\n${indent(`${id},\n${kwargs.join("\n")}`)}\n)`;
}

const INIT_CHAT_MODEL: ImportReq = {
  module: "langchain.chat_models",
  names: ["init_chat_model"],
};

/** agents.py: one node function per agent node — lazy model, prompt, invoke. */
export function renderLgAgent(
  node: AgentNode,
  inputKey: string,
  inputRef: TypeRef,
  stateClass: string,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg = node.config;
  if (cfg.tools && cfg.tools.length > 0) {
    throw new CodegenError(
      `agent "${node.name}": agent-attached tools are not supported by the ` +
        `langgraph target yet`,
    );
  }
  const imports: ImportReq[] = [
    INIT_CHAT_MODEL,
    { module: "state", names: [stateClass] },
  ];

  const lines: string[] = [
    `def ${node.name}(state: ${stateClass}) -> dict:`,
    indent(`model = ${renderModelCall(cfg.model, cfg.modelParams)}`),
    renderPromptAssign(cfg.instruction.segments, inputKey, inputRef, schemas),
  ];
  if (cfg.outputSchemaRef === "str") {
    lines.push(indent(`result = model.invoke(prompt)`));
    // `.text`, not `.content` (E2E finding F4): under langchain 1.x + Gemini,
    // `.content` is a list of content blocks (with thinking signatures) that
    // would leak verbatim into str-typed state keys and downstream prompts.
    lines.push(indent(`return {${pyStr(outputKey(node))}: result.text}`));
  } else {
    const output = resolveRef(cfg.outputSchemaRef, schemas);
    imports.push(...output.imports);
    lines.push(indent(`result = model.with_structured_output(${output.py}).invoke(prompt)`));
    lines.push(indent(`return {${pyStr(outputKey(node))}: result}`));
  }
  return { imports, code: `${lines.join("\n")}\n` };
}

/** nodes.py: one TODO-stub node function per function or tool node. */
export function renderLgStub(
  node: FunctionNode | ToolNode,
  inputKey: string,
  stateClass: string,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  rejectBody(node);
  const imports: ImportReq[] = [{ module: "state", names: [stateClass] }];
  const output = resolveRef(node.config.outputType, schemas);
  imports.push(...output.imports);

  const lines: string[] = [`def ${node.name}(state: ${stateClass}) -> dict:`];
  if (node.config.description) lines.push(indent(`"""${node.config.description}"""`));
  lines.push(
    indent(`node_input = state[${pyStr(inputKey)}]`),
    indent(`# TODO: implement ${node.name} — body not yet provided in the IR.`),
    indent(`output: ${output.py} = ...`),
    indent(`return {${pyStr(outputKey(node))}: output}`),
  );
  return { imports, code: `${lines.join("\n")}\n` };
}

/**
 * nodes.py: one node function per router — writes the route label to its own
 * state key; the conditional-edges wiring in graph.py reads it back.
 */
export function renderLgRouter(
  node: RouterNode,
  inputKey: string,
  stateClass: string,
): Fragment {
  rejectBody(node);
  const imports: ImportReq[] = [{ module: "state", names: [stateClass] }];
  const lines: string[] = [`def ${node.name}(state: ${stateClass}) -> dict:`];
  if (node.config.description) lines.push(indent(`"""${node.config.description}"""`));
  lines.push(
    indent(`node_input = state[${pyStr(inputKey)}]`),
    indent(
      `# TODO: implement ${node.name} — return one of: ${node.config.routes.join(", ")}.`,
    ),
    indent(`route: str = ...`),
    indent(`return {${pyStr(outputKey(node))}: route}`),
  );
  return { imports, code: `${lines.join("\n")}\n` };
}

/**
 * nodes.py: one node function per humanInput node — `interrupt()` pauses the
 * graph (checkpointer + thread_id required, wired in graph.py / main.py); the
 * resume value becomes the node's output. `payloadRef` ships as a JSON schema
 * in the interrupt payload; `responseSchemaRef` is enforced in-node, since
 * `interrupt` accepts/returns arbitrary JSON (ADR-0046).
 */
export function renderLgHumanInput(
  node: HumanInputNode,
  stateClass: string,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg = node.config;
  const imports: ImportReq[] = [
    { module: "langgraph.types", names: ["interrupt"] },
    { module: "state", names: [stateClass] },
  ];

  const payloadEntries: string[] = [`"message": ${pyStr(cfg.message)},`];
  if (cfg.payloadRef != null && cfg.payloadRef !== "str") {
    const payload = resolveRef(cfg.payloadRef, schemas);
    imports.push(...payload.imports);
    payloadEntries.push(`"payload_schema": ${payload.py}.model_json_schema(),`);
  }

  let result = "answer";
  if (cfg.responseSchemaRef != null && cfg.responseSchemaRef !== "str") {
    const response = resolveRef(cfg.responseSchemaRef, schemas);
    imports.push(...response.imports);
    result = `${response.py}.model_validate(answer)`;
  }

  const lines: string[] = [
    `def ${node.name}(state: ${stateClass}) -> dict:`,
    indent(`answer = interrupt(\n${indent(`{\n${indent(payloadEntries.join("\n"))}\n}`)}\n)`),
    indent(`return {${pyStr(outputKey(node))}: ${result}}`),
  ];
  return { imports, code: `${lines.join("\n")}\n` };
}

/**
 * nodes.py: one node function per join node — merges every upstream output
 * into one dict keyed by upstream node name (a codegen convention; downstream
 * consumers read the keys they need). Registered with `defer=True` in graph.py
 * so it runs only after all pending branches finish — LangGraph needs no
 * ADK-style failsafe outputs.
 */
export function renderLgJoin(
  node: JoinNode,
  upstreams: readonly GraphNode[],
  stateClass: string,
): Fragment {
  const imports: ImportReq[] = [{ module: "state", names: [stateClass] }];
  const entries = upstreams.map(
    (up) => `${pyStr(up.name)}: state[${pyStr(outputKey(up))}],`,
  );
  const merged = `{\n${indent(`${pyStr(outputKey(node))}: {\n${indent(entries.join("\n"))}\n}`)}\n}`;
  const lines: string[] = [`def ${node.name}(state: ${stateClass}) -> dict:`];
  if (node.config.description) lines.push(indent(`"""${node.config.description}"""`));
  lines.push(indent(`return ${merged}`));
  return { imports, code: `${lines.join("\n")}\n` };
}

/** Only `<N>_CriticOutput` of the reserved loop wrapper schemas is needed here. */
export function lgLoopSchemas(node: LoopNode): SchemaDef[] {
  return [
    {
      name: `${node.name}_CriticOutput`,
      fields: [
        { name: "status", type: "str" },
        { name: "feedback", type: "str" },
      ],
    },
  ];
}

/**
 * loops.py: one node function per loop node (ADR-0046) — the generator →
 * critic → reviser refinement as a plain Python loop over three
 * structured-output models. The outer graph still sees one node, matching
 * ADR-0039's encapsulation contract; `with_structured_output` replaces ADK's
 * `validate_node_output` helper entirely.
 */
export function renderLgLoop(
  node: LoopNode,
  inputKey: string,
  inputRef: TypeRef,
  stateClass: string,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg = node.config;
  const payload = resolveRef(cfg.payloadType, schemas);
  const criticOutput = `${node.name}_CriticOutput`;
  const imports: ImportReq[] = [
    INIT_CHAT_MODEL,
    { module: "state", names: [stateClass] },
    { module: "schemas", names: [criticOutput] },
    ...payload.imports,
  ];

  const constant = (role: string): string => `${node.name.toUpperCase()}_${role}_INSTRUCTION`;

  const specsExpr = schemas.has(inputRef)
    ? "specifications.model_dump_json()"
    : "specifications";
  const invoke = (target: string, model: string, schema: string, fstr: string): string =>
    [
      `${target} = ${model}.with_structured_output(${schema}).invoke(`,
      `    f"${fstr}",`,
      `)`,
    ].join("\n");

  const lines: string[] = [`def ${node.name}(state: ${stateClass}) -> dict:`];
  if (cfg.description) lines.push(indent(`"""${cfg.description}"""`));
  lines.push(
    indent(`specifications = state[${pyStr(inputKey)}]`),
    indent(`generator = ${renderModelCall(cfg.generator.model, undefined)}`),
    indent(`critic = ${renderModelCall(cfg.critic.model, undefined)}`),
    indent(`reviser = ${renderModelCall(cfg.reviser.model, undefined)}`),
    indent(
      invoke(
        "current",
        "generator",
        payload.py,
        `{${constant("GENERATOR")}}\\n\\nSpecifications:\\n{${specsExpr}}`,
      ),
    ),
    indent(`for _ in range(${cfg.maxIterations}):`),
    indent(
      invoke(
        "crit",
        "critic",
        criticOutput,
        `{${constant("CRITIC")}}\\n\\nCurrent:\\n{current.model_dump_json()}\\n\\nSpecifications:\\n{${specsExpr}}`,
      ),
      2,
    ),
    indent(`if crit.status == ${pyStr(cfg.approvalPhrase)}:`, 2),
    indent(`return {${pyStr(outputKey(node))}: current}`, 3),
    indent(
      invoke(
        "current",
        "reviser",
        payload.py,
        `{${constant("REVISER")}}\\n\\nCritic feedback:\\n{crit.feedback}\\n\\nCurrent:\\n{current.model_dump_json()}`,
      ),
      2,
    ),
    indent(
      `raise RuntimeError(${pyStr(
        `${node.name} failed to produce valid output after ${cfg.maxIterations} rounds`,
      )})`,
    ),
  );

  return { imports, code: `${lines.join("\n")}\n` };
}

/**
 * loops.py: the module-level `<N>_<ROLE>_INSTRUCTION` constants a loop node's
 * three sub-agent prompts are built from — a separate fragment because black's
 * blank-line policy differs between plain assignments and `def`s.
 */
export function renderLgLoopConstants(node: LoopNode): Fragment {
  const lines = (["GENERATOR", "CRITIC", "REVISER"] as const).map((role) =>
    strAssign(
      `${node.name.toUpperCase()}_${role}_INSTRUCTION`,
      pyStr(node.config[role.toLowerCase() as "generator" | "critic" | "reviser"].instruction),
      0,
    ),
  );
  return { imports: [], code: `${lines.join("\n")}\n` };
}
