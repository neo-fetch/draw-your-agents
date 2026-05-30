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
  InstructionTemplate,
  ModelParams,
  ScalarType,
  SchemaDef,
  TypeRef,
} from "@graphical-agents/ir";
import { CodegenError, type ImportReq, indent, pyStr } from "./python.ts";

/** A rendered code fragment plus the imports it depends on. */
export interface Fragment {
  readonly imports: readonly ImportReq[];
  readonly code: string;
}

/** Pydantic field type for an IR scalar, with any import it needs. */
function scalarType(type: ScalarType): { py: string; imports: ImportReq[] } {
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
 * pydantic class, imported from schemas.py).
 */
function resolveRef(
  ref: TypeRef,
  schemas: ReadonlyMap<string, SchemaDef>,
): { py: string; imports: ImportReq[] } {
  if (ref === "str") return { py: "str", imports: [] };
  if (!schemas.has(ref)) {
    throw new CodegenError(`type reference "${ref}" is not "str" or a declared schema`);
  }
  return { py: ref, imports: [{ module: "schemas", names: [ref] }] };
}

/** schemas.py: one pydantic BaseModel per IR schema. */
export function renderSchema(schema: SchemaDef): Fragment {
  const imports: ImportReq[] = [{ module: "pydantic", names: ["BaseModel"] }];
  const lines = schema.fields.map((field) => {
    const { py, imports: fieldImports } = scalarType(field.type);
    imports.push(...fieldImports);
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

/** Render an Agent instruction template as one source-bound string (ADR-0008). */
function renderInstruction(template: InstructionTemplate): string {
  const text = template.segments
    .map((seg) =>
      seg.type === "text" ? seg.value : `<${seg.schema}.${seg.field} from ${seg.source}>`,
    )
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
