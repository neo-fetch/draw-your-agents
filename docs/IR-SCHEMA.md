# Graph IR — Contract

The IR is the single source of truth ([ADR-0001](DECISIONS.md)). Machine contract:
[`packages/ir/schema/ir.schema.json`](../packages/ir/schema/ir.schema.json).
TS types: [`packages/ir/src/types.ts`](../packages/ir/src/types.ts).
Worked example: [`packages/ir/fixtures/city-time.ir.json`](../packages/ir/fixtures/city-time.ir.json).

## Top level
```jsonc
{
  "irVersion": "0.1.0",            // semver of the IR format
  "name": "city_time_workflow",    // python identifier; becomes root_agent name
  "description": "...",            // optional
  "schemas": [ /* SchemaDef */ ],  // pydantic models referenced by ref
  "tools":   [ /* ToolDef */ ],    // optional; agent-callable tool library (root graph only)
  "nodes":   [ /* Node */ ],
  "edges":   [ /* Edge */ ]        // plain directed graph; from may be "START"
}
```

## Schemas (pydantic models)
```jsonc
{ "name": "CityTime", "fields": [
  { "name": "time_info", "type": "str" },          // type ∈ scalar | declared schema name
  { "name": "city", "type": "str", "optional": false }
]}
```
A **type reference** anywhere (`field.type`, `inputType`, `outputType`, `inputSchemaRef`,
`outputSchemaRef`) is a scalar (`str|int|float|bool|date|datetime`) or the `name` of a
declared schema (ADR-0037 — field types may now nest one schema inside another, e.g.
`{"name":"customer","type":"Customer"}`). `inputSchemaRef` may also be `null`.

## Tool library (agent-callable tools, ADR-0059)
```jsonc
"tools": [
  { "name": "check_python_syntax",                 // python identifier; flat namespace with nodes + schemas
    "description": "Check whether a Python source string parses. ...",   // required — the LLM reads it
    "params": [ { "name": "code", "type": "str" } ],                      // flat named args, any scalar or root schema
    "returns": "str",                                                     // any scalar or root schema
    "body": "import ast\n..." }                                          // params in scope by name; return a plain value
]
```
A library tool is a function an **agent decides to call** while it works — not a graph step.
It has no edges and no canvas card. Agents opt in with `config.tools: ["check_python_syntax"]`,
and each loop role likewise with `generator|critic|reviser.tools`. Contrast a `tool` **node**
(below), which is a pipeline step wired by edges.

- The library lives on the **root** graph only; refs from any nesting depth resolve against it.
- Codegen emits `agent_tools.py` (both targets): the body in `_<name>_impl(<params>)`, plus a
  public `<name>(<params>)` whose docstring is `description`. A schema-typed return is
  `.model_dump()`ed in the public def; schema-typed params are validated by the runtime.
- **ADK:** `tools=[...]` on `Agent` / the loop's `LlmAgent`s. ADK 2.0 combines tools with
  `output_schema` (it injects `set_model_response` on the Gemini API), so typed outputs stay.
- **LangGraph:** `create_agent(model, tools=[...], response_format=<output schema>)`, run through
  `run_tool_agent` (emitted into `agent_tools.py`).
- `body: null` emits a `NotImplementedError` stub.

## Nodes
Common: `id` (unique, stable), `type`, `name` (unique python identifier — used as the codegen
symbol and as the `<... from name>` source), `config`, optional `ui: {x, y}`.

### agent
```jsonc
{ "id": "n_report", "type": "agent", "name": "city_report",
  "config": {
    "model": "gemini-flash-latest",
    "instruction": { "segments": [
      { "type": "text", "value": "It is " },
      { "type": "var", "schema": "CityTime", "field": "time_info", "source": "lookup_time" }
    ]},
    "modelParams": { "temperature": 0.2, "topP": 0.95, "topK": 40, "maxOutputTokens": 1024 },
    "mode": "task",                  // task | single_turn
    "tools": ["check_python_syntax"], // names in the root tool library (ADR-0059)
    "inputSchemaRef": "CityTime",    // must equal the schema of any var segment used
    "outputSchemaRef": "str"
  }}
```

### function
```jsonc
{ "id": "n_lookup", "type": "function", "name": "lookup_time",
  "config": { "description": "...", "inputType": "str", "outputType": "CityTime",
              "emits": "output", "body": null } }   // body null → generate a TODO stub
```

#### `body` — the target-neutral contract (ADR-0056)
A `body` is the inside of a plain Python function: **`node_input` is in scope** and the body
**returns a plain value** — never an `Event`, never a state dict. Codegen puts it verbatim in
`_<name>_impl` and adapts the return value per target:

| node | body returns | ADK wrapper | LangGraph wrapper |
|---|---|---|---|
| function / tool | `outputType` | `Event(output=…)` (or `message`, per `emits`) | `{"<name>_output": …}` |
| router | one of `routes` (a `str`) | `Event(route=…)` | `{"<name>_output": …}` |

The body is dedented before emission, so leading indentation carried in from a copy-paste is
harmless. `body: null` emits a TODO stub instead. Because the wrapper *calls* the body rather than
rewriting its `return`s, early returns and nested defs work unchanged.

### router
```jsonc
{ "id": "n_route", "type": "router", "name": "router",
  "config": { "description": "...", "routes": ["BUG", "SUPPORT"], "inputType": "str", "body": null } }
```
Branch targets are edges out of the router carrying a matching `route` label. A router produces
**no output** — on ADK a `function`/`tool` placed directly after a router therefore receives
`node_input=None` and fails pydantic coercion (finding F6); use an `agent` branch target, or put
the function one hop further down. LangGraph is unaffected.

### join / humanInput
```jsonc
{ "id": "n_join", "type": "join", "name": "collect", "config": { "description": "..." } }
{ "id": "n_ask", "type": "humanInput", "name": "ask_user",
  "config": { "message": "Enter a number:", "payloadRef": null, "responseSchemaRef": null } }
```

### tool
```jsonc
{ "id": "n_fetch", "type": "tool", "name": "fetch_data",
  "config": { "description": "...", "inputType": "str", "outputType": "Article",
              "body": null } }   // body null → generate a TODO stub
```
A **pipeline step**, not something an agent calls: it compiles to a plain function node exactly
like `function` (`def <name>(node_input) -> Event`, E2E finding F3 / ADR-0053 — the old
`FunctionTool` wrapper of ADR-0019 broke at runtime). Emits on the `output` channel. For a
function an *agent* may call, use the [tool library](#tool-library-agent-callable-tools-adr-0059).

### workflow (nested)
```jsonc
{ "id": "n_nested", "type": "workflow", "name": "nested_workflow",
  "config": { "description": "...", "graph": { /* a full GraphIR — same shape as the root */ } } }
```
A `workflow` node carries a complete sub-IR in `config.graph` (its own START,
nodes, edges, schemas) and the validator recurses with the **same** rules
(ADR-0017). Node `name`s and schema names share **one flat global namespace**
across parent + every nested sub-graph (invariant 1 holds across nesting).

## Edges
```jsonc
{ "from": "START", "to": "n_city_gen" }                 // START begins the graph (may repeat)
{ "from": "n_route", "to": "n_bug", "route": "BUG" }    // route label only on router out-edges
```

## Invariants (enforced by the validator / `scripts/check_ir.py`)
1. `name`s and node `name`s are valid, non-keyword python identifiers; ids and names are unique.
2. `"START"` is reserved; it may appear only as an edge `from`, never as a node name or edge `to`.
3. Every edge endpoint exists; at least one `START` edge; all nodes reachable from START.
4. The graph is a DAG (no cycles in v1).
5. Every type reference resolves to a scalar, `null` (where allowed), or a declared schema. Schema-typed field references must form a DAG — `SchemaField.type` may name another declared schema, but cycles (including self-reference) are rejected (ADR-0037).
6. For each prompt `var` segment: `source` is a node; its output is the structured `schema`
   (not `str`); the schema has `field`. **Positional** (`via` omitted/`"input"`): the consuming
   agent's `inputSchemaRef` equals `schema` (single-schema rail). **Session-state** (`via: "state"`,
   ADR-0051): `source` must be a control-flow **ancestor** of the consumer; `inputSchemaRef` does
   **not** apply (an agent may mix state variables from several ancestor schemas).
7. Router: declared `routes` ⇔ out-edge `route` labels (no missing, no extra, none unlabeled).
   Non-router out-edges carry no `route` label. A branch target **may** have out-edges of its own
   (a *branch continuation*, ADR-0054) — it compiles to a row headed by that target, verified
   against a live ADK run (ADR-0055). Two declared routes may share one branch target.

8. A `body` follows the target-neutral contract above: it must not construct `Event(...)`
   (`BODY_ADK_FLAVORED`, ADR-0056) — that is the pre-ADR-0056 form and would compile to
   `Event(output=Event(...))`. Library tool bodies get the same checks.

9. Tool library (ADR-0059): only the root graph declares `tools` (`TOOL_LIBRARY_NOT_ROOT`);
   tool names are unique identifiers that clash with no node, schema, or generated symbol
   (`INVALID_TOOL_NAME`, `DUPLICATE_TOOL_NAME`, `TOOL_NAME_CLASH`); each has a non-empty
   `description` and resolvable, uniquely-named params / return type (`TOOL_MISSING_DESCRIPTION`,
   `TOOL_BAD_PARAM_NAME`, `TOOL_UNKNOWN_PARAM_TYPE`, `TOOL_UNKNOWN_RETURN_TYPE`). Every entry of an
   agent's or loop role's `tools` names a library tool, at most once (`UNKNOWN_TOOL_REF`,
   `DUPLICATE_TOOL_REF`). Library findings carry `tool` instead of `nodeId`.

## Warnings (do not block codegen)
`compile` throws on errors only, so these annotate a graph that still generates:
- `JOIN_MISSING_FAILSAFE` — a join upstream that may never emit on the output channel.
- `BODY_NO_RETURN` — a body with no `return`/`raise`/`yield`; the node produces `None`.
- `BODY_ROUTE_UNDECLARED` — every route literal a router body returns is undeclared.
- `INCOMPATIBLE_INTEGRATION` — reserved, Phase 3.
