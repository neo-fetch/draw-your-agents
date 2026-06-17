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
    "tools": [],
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

### router
```jsonc
{ "id": "n_route", "type": "router", "name": "router",
  "config": { "description": "...", "routes": ["BUG", "SUPPORT"], "inputType": "str", "body": null } }
```
Branch targets are edges out of the router carrying a matching `route` label.

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
Compiles to a `FunctionTool` wrapping an underlying `<name>_impl` function
(ADR-0019). Emits on the `output` channel; the edge symbol is the wrapper.

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
   Non-router out-edges carry no `route` label.
