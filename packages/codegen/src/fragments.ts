/**
 * Per-node template fragments (ADR-0003) for the constructs the edges compiler
 * already supports: agent and function nodes in a linear chain. Each fragment is
 * a pure function IR-node → { imports, code }; the assembler ([project.ts])
 * dedupes imports and concatenates bodies. Routers, joins, parallel, tools and
 * nested workflows are out of this slice and rejected loud (same as ADR-0010).
 */
import type {
  AgentConfig,
  AgentNode,
  FunctionNode,
  GraphIR,
  HumanInputNode,
  InstructionTemplate,
  JoinNode,
  LoopNode,
  ModelParams,
  RouterNode,
  ScalarType,
  SchemaDef,
  ToolNode,
  TypeRef,
} from "@graphical-agents/ir";
import { CodegenError, type ImportReq, indent, pyStr } from "./python.ts";

/** A rendered code fragment plus the imports it depends on. */
export interface Fragment {
  readonly imports: readonly ImportReq[];
  readonly code: string;
}

/**
 * Pydantic field type for an IR scalar, with any import it needs. Shared with
 * the LangGraph target (ADR-0045).
 */
export function scalarType(type: ScalarType): { py: string; imports: ImportReq[] } {
  switch (type) {
    case "str":
    case "int":
    case "float":
    case "bool":
      return { py: type, imports: [] };
    case "date":
      return { py: "date", imports: [{ module: "datetime", names: ["date"] }] };
    case "datetime":
      return { py: "datetime", imports: [{ module: "datetime", names: ["datetime"] }] };
    default: {
      const exhaustive: never = type;
      throw new CodegenError(`unknown scalar type "${exhaustive as string}"`);
    }
  }
}

/**
 * Resolve a type reference used as a function I/O or agent schema slot. `"str"`
 * is the builtin; any other ref must name a declared schema (rendered as the
 * pydantic class, imported from schemas.py). Shared with the LangGraph target
 * (ADR-0045) — both targets keep their pydantic models in a `schemas` module.
 */
export function resolveRef(
  ref: TypeRef,
  schemas: ReadonlyMap<string, SchemaDef>,
): { py: string; imports: ImportReq[] } {
  if (ref === "str") return { py: "str", imports: [] };
  if (!schemas.has(ref)) {
    throw new CodegenError(`type reference "${ref}" is not "str" or a declared schema`);
  }
  return { py: ref, imports: [{ module: "schemas", names: [ref] }] };
}

/**
 * schemas.py: one pydantic BaseModel per IR schema.
 *
 * A field's `type` is a TypeRef (ADR-0037): a scalar OR the name of another
 * declared schema. A schema-typed field renders as the bare class name (no
 * import — both classes live in the same `schemas.py` module); `project.ts`
 * guarantees declared-before-referenced emission via topological order.
 */
export function renderSchema(
  schema: SchemaDef,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const imports: ImportReq[] = [{ module: "pydantic", names: ["BaseModel"] }];
  const lines = schema.fields.map((field) => {
    let py: string;
    if (schemas.has(field.type)) {
      py = field.type; // nested schema — same module, no import needed
    } else {
      const resolved = scalarType(field.type as ScalarType);
      py = resolved.py;
      imports.push(...resolved.imports);
    }
    let annotation = py;
    let suffix = "";
    if (field.optional) {
      annotation = `Optional[${py}]`;
      imports.push({ module: "typing", names: ["Optional"] });
      suffix = " = None";
    }
    return `    ${field.name}: ${annotation}${suffix}`;
  });
  const body = lines.length > 0 ? lines.join("\n") : "    pass";
  return { imports, code: `class ${schema.name}(BaseModel):\n${body}\n` };
}

/** functions.py: one `def` per function node — body, or a TODO stub. */
export function renderFunction(
  node: FunctionNode,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg = node.config;
  const imports: ImportReq[] = [{ module: "google.adk", names: ["Event"] }];

  const input = resolveRef(cfg.inputType, schemas);
  imports.push(...input.imports);
  const output = resolveRef(cfg.outputType, schemas);
  imports.push(...output.imports);

  const emits = cfg.emits ?? "output"; // ADK Event channel — output (default) or message
  const channelVar = emits === "message" ? "message" : "output";

  const header: string[] = [`def ${node.name}(node_input: ${input.py}) -> Event:`];
  if (cfg.description) header.push(indent(`"""${cfg.description}"""`));

  let body: string;
  if (cfg.body != null) {
    body = indent(cfg.body);
  } else {
    // null body → a clear stub with the right signature and Event return.
    body = indent(
      [
        `# TODO: implement ${node.name} — body not yet provided in the IR.`,
        `${channelVar}: ${output.py} = ...`,
        `return Event(${channelVar}=${channelVar})`,
      ].join("\n"),
    );
  }

  return { imports, code: `${header.join("\n")}\n${body}\n` };
}

/** functions.py: one `def` per router — returns `Event(route=...)`, or a TODO stub. */
export function renderRouter(
  node: RouterNode,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg = node.config;
  const imports: ImportReq[] = [{ module: "google.adk", names: ["Event"] }];

  const input = resolveRef(cfg.inputType ?? "str", schemas);
  imports.push(...input.imports);

  const header: string[] = [`def ${node.name}(node_input: ${input.py}) -> Event:`];
  if (cfg.description) header.push(indent(`"""${cfg.description}"""`));

  let body: string;
  if (cfg.body != null) {
    body = indent(cfg.body);
  } else {
    // null body → a stub that returns one of the declared routes.
    body = indent(
      [
        `# TODO: implement ${node.name} — return Event(route=...) with one of: ${cfg.routes.join(", ")}.`,
        `route: str = ...`,
        `return Event(route=route)`,
      ].join("\n"),
    );
  }

  return { imports, code: `${header.join("\n")}\n${body}\n` };
}

/**
 * functions.py: one generator `def` per humanInput node (ADR-0016).
 *
 * Per the ADK graph-workflow human-input pattern, a human-input node renders as
 * a zero-arg generator that yields a `RequestInput` — the runtime pauses the
 * graph there and forwards the user's response to the next node's `node_input`
 * (so the function itself does not wrap or return an `Event`).
 *
 *   def ask_user():
 *       yield RequestInput(
 *           message="...",
 *           payload=<PayloadSchema>,           # omitted when payloadRef is null
 *           response_schema=<ResponseSchema>,  # omitted when responseSchemaRef is null
 *       )
 */
export function renderHumanInput(
  node: HumanInputNode,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg = node.config;
  const imports: ImportReq[] = [{ module: "google.adk.events", names: ["RequestInput"] }];

  const kwargs: string[] = [`message=${pyStr(cfg.message)},`];

  if (cfg.payloadRef != null) {
    const payload = resolveRef(cfg.payloadRef, schemas);
    imports.push(...payload.imports);
    kwargs.push(`payload=${payload.py},`);
  }
  if (cfg.responseSchemaRef != null) {
    const response = resolveRef(cfg.responseSchemaRef, schemas);
    imports.push(...response.imports);
    kwargs.push(`response_schema=${response.py},`);
  }

  const body = `def ${node.name}():\n${indent(`yield RequestInput(\n${indent(kwargs.join("\n"))}\n)`)}\n`;
  return { imports, code: body };
}

/** workflow.py: one `JoinNode(name=...)` per join node (ADR-0015). */
export function renderJoin(node: JoinNode): Fragment {
  const imports: ImportReq[] = [{ module: "google.adk.workflow", names: ["JoinNode"] }];
  const body = `${node.name} = JoinNode(\n${indent(`name=${pyStr(node.name)},`)}\n)\n`;
  return { imports, code: body };
}

/** Codegen-internal symbol for a tool node's underlying function (ADR-0019). */
export function toolImplName(node: ToolNode): string {
  return `${node.name}_impl`;
}

/**
 * functions.py: one `def <name>_impl(node_input: <inputType>) -> Event:` per
 * tool node (ADR-0019). Mirrors `renderFunction` (output channel only — tools
 * have no `emits` choice).
 */
export function renderToolImpl(
  node: ToolNode,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg = node.config;
  const imports: ImportReq[] = [{ module: "google.adk", names: ["Event"] }];

  const input = resolveRef(cfg.inputType, schemas);
  imports.push(...input.imports);
  const output = resolveRef(cfg.outputType, schemas);
  imports.push(...output.imports);

  const implName = toolImplName(node);
  const header: string[] = [`def ${implName}(node_input: ${input.py}) -> Event:`];
  if (cfg.description) header.push(indent(`"""${cfg.description}"""`));

  let body: string;
  if (cfg.body != null) {
    body = indent(cfg.body);
  } else {
    body = indent(
      [
        `# TODO: implement ${node.name} — body not yet provided in the IR.`,
        `output: ${output.py} = ...`,
        `return Event(output=output)`,
      ].join("\n"),
    );
  }

  return { imports, code: `${header.join("\n")}\n${body}\n` };
}

/**
 * workflow.py: one `<name> = FunctionTool(func=<name>_impl)` per tool node
 * (ADR-0019). Emitted inline before that level's joins and `Workflow(...)`
 * assignment, in the same slot pattern as `renderJoin`.
 */
export function renderToolWrapper(node: ToolNode): Fragment {
  const imports: ImportReq[] = [{ module: "google.adk.tools", names: ["FunctionTool"] }];
  const body = `${node.name} = FunctionTool(func=${toolImplName(node)})\n`;
  return { imports, code: body };
}

/**
 * Render an Agent instruction template as one string. A positional var renders
 * to the source-bound form `<schema.field from source>` (ADR-0008); a
 * non-adjacent `via: "state"` var renders to the `{schema.field}` ADK
 * session-state form (ADR-0051) — read from session state, not `node_input`.
 */
function renderInstruction(template: InstructionTemplate): string {
  const text = template.segments
    .map((seg) => {
      if (seg.type === "text") return seg.value;
      return seg.via === "state"
        ? `{${seg.schema}.${seg.field}}`
        : `<${seg.schema}.${seg.field} from ${seg.source}>`;
    })
    .join("");
  return pyStr(text);
}

/** ADK model-param kwargs (snake_case), in a stable order. */
function renderModelParams(params: ModelParams): string[] {
  const map: [keyof ModelParams, string][] = [
    ["temperature", "temperature"],
    ["topP", "top_p"],
    ["topK", "top_k"],
    ["maxOutputTokens", "max_output_tokens"],
  ];
  const lines: string[] = [];
  for (const [key, py] of map) {
    const value = params[key];
    if (value !== undefined) lines.push(`${py}=${value},`);
  }
  return lines;
}

/** agents.py: one `Agent(...)` per agent node. */
export function renderAgent(
  node: AgentNode,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg: AgentConfig = node.config;
  const imports: ImportReq[] = [{ module: "google.adk", names: ["Agent"] }];

  const kwargs: string[] = [
    `name=${pyStr(node.name)},`,
    `model=${pyStr(cfg.model)},`,
    `instruction=${renderInstruction(cfg.instruction)},`,
  ];

  if (cfg.modelParams) kwargs.push(...renderModelParams(cfg.modelParams));

  if (cfg.inputSchemaRef != null) {
    const input = resolveRef(cfg.inputSchemaRef, schemas);
    imports.push(...input.imports);
    kwargs.push(`input_schema=${input.py},`);
  }

  const output = resolveRef(cfg.outputSchemaRef, schemas);
  imports.push(...output.imports);
  kwargs.push(`output_schema=${output.py},`);

  const body = `${node.name} = Agent(\n${indent(kwargs.join("\n"))}\n)\n`;
  return { imports, code: body };
}

/** Index schemas by name for ref resolution. */
export function indexSchemas(ir: GraphIR): ReadonlyMap<string, SchemaDef> {
  const map = new Map<string, SchemaDef>();
  for (const schema of ir.schemas) map.set(schema.name, schema);
  return map;
}

// --- Loop node (ADR-0039) ------------------------------------------------

/** The exported Python symbol for a loop node's `@node` orchestrator. */
export function loopOrchestratorName(node: LoopNode): string {
  return `${node.name}_orchestrator`;
}

/**
 * Canonical wrapper schemas a loop node's orchestrator passes to its three
 * sub-agents (ADR-0039). Returned as plain `SchemaDef`s so the existing
 * `topologicalSchemas` path in [project.ts] emits them after the user's
 * `payloadType`/`inputType` schemas (declared-before-used).
 *
 * `<N>_CriticOutput` is the canonical critic contract `{status, feedback}` —
 * not user-configurable in v1.
 */
export function loopWrapperSchemas(node: LoopNode): SchemaDef[] {
  const cfg = node.config;
  return [
    {
      name: `${node.name}_GenInput`,
      fields: [{ name: "specifications", type: cfg.inputType }],
    },
    {
      name: `${node.name}_CriticInput`,
      fields: [
        { name: "current", type: cfg.payloadType },
        { name: "specifications", type: cfg.inputType },
      ],
    },
    {
      name: `${node.name}_ReviserInput`,
      fields: [
        { name: "current", type: cfg.payloadType },
        { name: "revision_feedback", type: "str" },
      ],
    },
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
 * `loops.py`: the project-wide `validate_node_output` helper — one copy per
 * project, regardless of how many loop nodes there are. Mirrors the helper in
 * `exploring/generic-workflow.py` 1:1.
 */
export function renderValidateNodeOutputHelper(): Fragment {
  const imports: ImportReq[] = [
    { module: "typing", names: ["Any"] },
    { module: "pydantic", names: ["BaseModel"] },
  ];
  const code = [
    `def validate_node_output(schema_cls: type[BaseModel], raw_output: Any) -> BaseModel:`,
    `    if isinstance(raw_output, schema_cls):`,
    `        return raw_output`,
    `    if isinstance(raw_output, dict):`,
    `        return schema_cls.model_validate(raw_output)`,
    `    if isinstance(raw_output, BaseModel):`,
    `        return schema_cls.model_validate(raw_output.model_dump())`,
    `    raise ValueError(f"Cannot validate {type(raw_output)} into {schema_cls}")`,
    ``,
  ].join("\n");
  return { imports, code };
}

/**
 * `loops.py`: one `@node(rerun_on_resume=True) async def <N>_orchestrator(ctx)`
 * per loop node (ADR-0039). The body is parameterized straight from
 * `exploring/generic-workflow.py`:
 *  - build the three `LlmAgent`s (model + instruction + typed I/O schemas);
 *  - read the spec from `ctx.state.get("<N>_input", "")` (canonical key —
 *    user wires upstream by writing to that state slot);
 *  - run the generator once, validate output via `validate_node_output`;
 *  - `for _ in range(<maxIterations>)`: critic → approval check → reviser;
 *  - exhaustion → `raise RuntimeError(...)`.
 */
export function renderLoopOrchestrator(
  node: LoopNode,
  schemas: ReadonlyMap<string, SchemaDef>,
): Fragment {
  const cfg = node.config;
  const orchName = loopOrchestratorName(node);
  const inputName = `${node.name}_input`;
  const outputKey = `${node.name}_output`;

  const payload = resolveRef(cfg.payloadType, schemas);

  const imports: ImportReq[] = [
    { module: "google.adk", names: ["Context"] },
    { module: "google.adk.agents", names: ["LlmAgent"] },
    { module: "google.adk.workflow", names: ["node"] },
    {
      module: "schemas",
      names: [
        `${node.name}_GenInput`,
        `${node.name}_CriticInput`,
        `${node.name}_ReviserInput`,
        `${node.name}_CriticOutput`,
      ],
    },
    ...payload.imports,
  ];

  const subAgentBlock = (
    varName: string,
    role: "generator" | "critic" | "reviser",
    inputSchemaName: string,
    outputSchemaName: string,
    outputKeyName: string,
  ): string => {
    const sub = cfg[role];
    return [
      `${varName} = LlmAgent(`,
      `    model=${pyStr(sub.model)},`,
      `    name=${pyStr(`${node.name}_${role}`)},`,
      `    instruction=${pyStr(sub.instruction)},`,
      `    input_schema=${inputSchemaName},`,
      `    output_schema=${outputSchemaName},`,
      `    output_key=${pyStr(outputKeyName)},`,
      `)`,
    ].join("\n");
  };

  const body = [
    `@node(rerun_on_resume=True)`,
    `async def ${orchName}(ctx: Context):`,
    indent(
      subAgentBlock(
        "generator",
        "generator",
        `${node.name}_GenInput`,
        payload.py,
        `${node.name}_generated`,
      ),
    ),
    indent(
      subAgentBlock(
        "critic",
        "critic",
        `${node.name}_CriticInput`,
        `${node.name}_CriticOutput`,
        `${node.name}_critic_feedback`,
      ),
    ),
    indent(
      subAgentBlock(
        "reviser",
        "reviser",
        `${node.name}_ReviserInput`,
        payload.py,
        `${node.name}_revised`,
      ),
    ),
    indent(`specs = ctx.state.get(${pyStr(inputName)}, "")`),
    indent(
      `raw = await ctx.run_node(generator, ${node.name}_GenInput(specifications=specs))`,
    ),
    indent(`current = validate_node_output(${payload.py}, raw)`),
    indent(`for _ in range(${cfg.maxIterations}):`),
    indent(
      `    critic_raw = await ctx.run_node(critic, ${node.name}_CriticInput(current=current, specifications=specs))`,
    ),
    indent(
      `    crit = validate_node_output(${node.name}_CriticOutput, critic_raw)`,
    ),
    indent(`    if crit.status == ${pyStr(cfg.approvalPhrase)}:`),
    indent(`        ctx.state[${pyStr(outputKey)}] = current.model_dump()`),
    indent(`        return`),
    indent(
      `    revised_raw = await ctx.run_node(reviser, ${node.name}_ReviserInput(current=current, revision_feedback=crit.feedback))`,
    ),
    indent(`    current = validate_node_output(${payload.py}, revised_raw)`),
    indent(
      `raise RuntimeError(${pyStr(`${node.name} failed to produce valid output after ${cfg.maxIterations} rounds`)})`,
    ),
    ``,
  ].join("\n");

  return { imports, code: body };
}
