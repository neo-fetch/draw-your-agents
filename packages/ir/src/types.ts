/**
 * Graph IR — TypeScript types. The keystone contract (see ADR-0001).
 * Kept in lockstep with schema/ir.schema.json and docs/IR-SCHEMA.md.
 */

export const IR_VERSION = "0.1.0";

/** Either the literal "str" or the `name` of a declared SchemaDef. */
export type TypeRef = string;
export type ScalarType = "str" | "int" | "float" | "bool" | "date" | "datetime";

export interface SchemaField {
  name: string;
  type: ScalarType;
  optional?: boolean;
  default?: unknown;
}

export interface SchemaDef {
  name: string;
  fields: SchemaField[];
}

// --- Instruction template (structured prompt, not a raw string) ---
export interface TextSegment {
  type: "text";
  value: string;
}
export interface VarSegment {
  type: "var";
  /** Name of the producing node's output schema. */
  schema: string;
  /** Field within that schema. */
  field: string;
  /** `name` of the node that produces the value (rendered as `<schema.field from source>`). */
  source: string;
}
export type InstructionSegment = TextSegment | VarSegment;
export interface InstructionTemplate {
  segments: InstructionSegment[];
}

// --- Node configs ---
export interface ModelParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
}

export interface AgentConfig {
  model: string;
  instruction: InstructionTemplate;
  modelParams?: ModelParams;
  mode?: "task" | "single_turn";
  tools?: string[];
  /** Schema name | "str" | null. Must equal the schema of any var segment used. */
  inputSchemaRef?: TypeRef | null;
  /** Schema name | "str". */
  outputSchemaRef: TypeRef;
}

export interface FunctionConfig {
  description?: string;
  inputType: TypeRef;
  outputType: TypeRef;
  emits?: "output" | "message";
  /** null → generate a TODO stub with the correct signature. */
  body?: string | null;
}

export interface RouterConfig {
  description?: string;
  routes: string[];
  inputType?: TypeRef;
  body?: string | null;
}

export interface JoinConfig {
  description?: string;
}

export interface HumanInputConfig {
  message: string;
  payloadRef?: string | null;
  responseSchemaRef?: string | null;
}

// --- Nodes ---
export type NodeType =
  | "agent"
  | "function"
  | "router"
  | "tool"
  | "join"
  | "humanInput"
  | "workflow";

export interface UiPosition {
  x: number;
  y: number;
}

interface BaseNode<T extends NodeType, C> {
  id: string;
  type: T;
  /** Unique python identifier; the codegen symbol and the `<... from name>` source. */
  name: string;
  config: C;
  ui?: UiPosition;
}

export type AgentNode = BaseNode<"agent", AgentConfig>;
export type FunctionNode = BaseNode<"function", FunctionConfig>;
export type RouterNode = BaseNode<"router", RouterConfig>;
export type JoinNode = BaseNode<"join", JoinConfig>;
export type HumanInputNode = BaseNode<"humanInput", HumanInputConfig>;

/** Tool and (nested) workflow nodes arrive in Phase 3. */
export type GraphNode =
  | AgentNode
  | FunctionNode
  | RouterNode
  | JoinNode
  | HumanInputNode;

// --- Edges & graph ---
/** Edge `from` may be this sentinel to mark a graph entry point. */
export const START = "START" as const;

export interface Edge {
  /** "START" or a node id. */
  from: string;
  /** A node id. */
  to: string;
  /** Present only on router out-edges; equals one of the router's declared routes. */
  route?: string;
}

export interface GraphIR {
  irVersion: string;
  name: string;
  description?: string;
  schemas: SchemaDef[];
  nodes: GraphNode[];
  edges: Edge[];
}
