/**
 * Headless test for path-scoped editing of nested workflow sub-graphs
 * (ADR-0050).
 *
 * Pins the two genuinely-global reducers and the wrap-don't-rewrite
 * retargeting pattern: (a) `addNodeAt` mints ids/names against the ROOT's
 * flat namespace (ADR-0017) but inserts into the graph at the path, and the
 * result still validates with only the expected fresh-node findings at a
 * path-prefixed location; (b) `renameNodeAt` renames path-scoped and
 * cascades agent var-sources / `tools[]` across every nesting level;
 * (c) the graph-local reducers (`irEdges.ts`, `schemas.ts`) retarget cleanly
 * through `updateGraphAtPath` with root arrays keeping referential identity.
 *
 * Runs under `node --test` against the native TS loader — no `npm install`
 * (ADR-0011 / ADR-0013), no zustand, no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  AgentNode,
  FunctionNode,
  GraphIR,
  WorkflowNode,
} from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { addNode, addNodeAt } from "../src/store/addNode.ts";
import { renameNodeAt } from "../src/store/irReducer.ts";
import { connectEdge, deleteEdge, deleteNode } from "../src/store/irEdges.ts";
import { renameSchema } from "../src/store/schemas.ts";
import { graphAtPath, updateGraphAtPath } from "../src/store/subgraph.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function loadNested(): GraphIR {
  return JSON.parse(
    readFileSync(join(fixturesDir, "nested.ir.json"), "utf8"),
  ) as GraphIR;
}

function subgraphOf(ir: GraphIR, id: string): GraphIR {
  return (ir.nodes.find((n) => n.id === id) as WorkflowNode).config.graph;
}

// --- addNodeAt -------------------------------------------------------------

test("addNodeAt inserts into the sub-graph only; name minted against the root", () => {
  // Add a function at the root first so it claims `function_1`; the nested
  // add must see it through the flat global namespace and mint `function_2`.
  const { ir: withRootFn } = addNode(loadNested(), "function");
  const rootFn = withRootFn.nodes[withRootFn.nodes.length - 1];
  assert.equal(rootFn.name, "function_1");

  const { ir, nodeId } = addNodeAt(withRootFn, ["n_nested"], "function");
  assert.notEqual(nodeId, "");
  assert.equal(ir.nodes.length, withRootFn.nodes.length, "root node count unchanged");
  const sub = subgraphOf(ir, "n_nested");
  assert.equal(sub.nodes.length, 3, "sub-graph gained the node");
  const added = sub.nodes.find((n) => n.id === nodeId)!;
  assert.equal(added.name, "function_2", "minted against root, not just the sub-graph");

  // Whole IR still validates with only UNREACHABLE_NODE findings, and the
  // nested one is located with the validator's path prefix (ADR-0017).
  const result = validate(ir);
  assert.deepEqual(
    result.errors.map((f) => f.code).sort(),
    ["UNREACHABLE_NODE", "UNREACHABLE_NODE"],
    JSON.stringify(result.errors),
  );
  assert.ok(result.errors.some((f) => f.nodeId === `n_nested/${nodeId}`));
});

test("addNodeAt can add a workflow inside a sub-graph; inner names stay globally unique", () => {
  const { ir, nodeId } = addNodeAt(loadNested(), ["n_nested"], "workflow");
  const sub = subgraphOf(ir, "n_nested");
  const wf = sub.nodes.find((n) => n.id === nodeId) as WorkflowNode;
  assert.equal(wf.type, "workflow");
  assert.ok(wf.config.graph.nodes.length === 1, "minimal sub-IR scaffolded");

  const result = validate(ir);
  assert.deepEqual(
    result.errors.map((f) => f.code),
    ["UNREACHABLE_NODE"],
    JSON.stringify(result.errors),
  );
  assert.equal(result.errors[0]!.nodeId, `n_nested/${nodeId}`);
});

test("addNodeAt no-ops on an invalid path", () => {
  const ir = loadNested();
  const res = addNodeAt(ir, ["n_missing"], "function");
  assert.equal(res.ir, ir);
  assert.equal(res.nodeId, "");
});

// --- renameNodeAt ----------------------------------------------------------

/** nested.ir.json + a root agent using the inner producer as a tool and a
 *  nested agent whose var chip sources the inner producer. */
function nestedWithAgents(): GraphIR {
  const ir = loadNested();
  const rootAgent: AgentNode = {
    id: "n_root_agent",
    type: "agent",
    name: "root_agent_node",
    config: {
      model: "gemini-flash-latest",
      instruction: { segments: [] },
      mode: "task",
      outputSchemaRef: "str",
      inputSchemaRef: null,
      tools: ["inner_step_a"],
    },
  };
  const innerAgent: AgentNode = {
    id: "n_inner_agent",
    type: "agent",
    name: "inner_agent_node",
    config: {
      model: "gemini-flash-latest",
      instruction: {
        segments: [
          { type: "var", schema: "str", field: "", source: "inner_step_a" },
        ],
      },
      mode: "task",
      outputSchemaRef: "str",
      inputSchemaRef: null,
    },
  };
  ir.nodes.push(rootAgent);
  const sub = subgraphOf(ir, "n_nested");
  sub.nodes.push(innerAgent);
  return ir;
}

test("renameNodeAt renames inside the sub-graph and cascades at every level", () => {
  const ir = nestedWithAgents();
  const next = renameNodeAt(ir, ["n_nested"], "n_inner_a", "step_alpha");

  const sub = subgraphOf(next, "n_nested");
  assert.equal(sub.nodes.find((n) => n.id === "n_inner_a")!.name, "step_alpha");
  // Root-level tools[] cascade (tools resolve globally by name).
  const rootAgent = next.nodes.find((n) => n.id === "n_root_agent") as AgentNode;
  assert.deepEqual(rootAgent.config.tools, ["step_alpha"]);
  // Same-level var-chip source cascade.
  const innerAgent = sub.nodes.find((n) => n.id === "n_inner_agent") as AgentNode;
  const seg = innerAgent.config.instruction.segments[0];
  assert.equal(seg.type === "var" && seg.source, "step_alpha");
  // Pure: original untouched.
  assert.equal(
    subgraphOf(ir, "n_nested").nodes.find((n) => n.id === "n_inner_a")!.name,
    "inner_step_a",
  );
});

test("renameNodeAt at the root cascades into nested agents", () => {
  const ir = nestedWithAgents();
  const sub = subgraphOf(ir, "n_nested");
  (sub.nodes.find((n) => n.id === "n_inner_agent") as AgentNode).config.tools =
    ["preprocess"];

  const next = renameNodeAt(ir, [], "n_preprocess", "prepare");
  assert.equal(next.nodes.find((n) => n.id === "n_preprocess")!.name, "prepare");
  const innerAgent = subgraphOf(next, "n_nested").nodes.find(
    (n) => n.id === "n_inner_agent",
  ) as AgentNode;
  assert.deepEqual(
    innerAgent.config.tools,
    ["prepare"],
    "previously-deferred recursive cascade now lands",
  );
});

test("renameNodeAt no-op contracts return the same reference", () => {
  const ir = nestedWithAgents();
  assert.equal(renameNodeAt(ir, ["n_missing"], "n_inner_a", "x"), ir);
  assert.equal(renameNodeAt(ir, ["n_nested"], "n_gone", "x"), ir);
  // The id exists at root, not in the sub-graph: path-scoped lookup must miss.
  assert.equal(renameNodeAt(ir, ["n_nested"], "n_preprocess", "x"), ir);
  assert.equal(
    renameNodeAt(ir, ["n_nested"], "n_inner_a", "inner_step_a"),
    ir,
  );
});

// --- graph-local reducers retargeted via updateGraphAtPath ------------------

test("topology reducers wrapped at a path mutate only the sub-graph", () => {
  const ir = loadNested();

  const connected = updateGraphAtPath(ir, ["n_nested"], (g) =>
    connectEdge(g, "n_inner_b", "n_inner_a"),
  );
  assert.equal(connected.edges, ir.edges, "root edges keep identity");
  assert.equal(graphAtPath(connected, ["n_nested"])!.edges.length, 3);

  const deletedEdge = updateGraphAtPath(connected, ["n_nested"], (g) =>
    deleteEdge(g, "n_inner_b", "n_inner_a"),
  );
  assert.equal(graphAtPath(deletedEdge, ["n_nested"])!.edges.length, 2);

  const deletedNode = updateGraphAtPath(ir, ["n_nested"], (g) =>
    deleteNode(g, "n_inner_b"),
  );
  const sub = graphAtPath(deletedNode, ["n_nested"])!;
  assert.equal(sub.nodes.length, 1);
  assert.equal(sub.edges.length, 1, "cascade removed the inner edge");
  assert.equal(deletedNode.nodes.length, 3, "root nodes untouched");
  // deleteNode of a root id inside the sub-graph is a no-op → same root ref.
  assert.equal(
    updateGraphAtPath(ir, ["n_nested"], (g) => deleteNode(g, "n_preprocess")),
    ir,
  );
});

test("renameSchema wrapped at a path cascades sub-graph refs only", () => {
  const ir = loadNested();
  const sub = subgraphOf(ir, "n_nested");
  sub.schemas.push({ name: "Inner", fields: [{ name: "f", type: "str" }] });
  (sub.nodes.find((n) => n.id === "n_inner_a") as FunctionNode).config.outputType =
    "Inner";
  ir.schemas.push({ name: "Outer", fields: [{ name: "f", type: "str" }] });

  const next = updateGraphAtPath(ir, ["n_nested"], (g) =>
    renameSchema(g, "Inner", "InnerRenamed"),
  );
  const nextSub = subgraphOf(next, "n_nested");
  assert.equal(nextSub.schemas[0].name, "InnerRenamed");
  assert.equal(
    (nextSub.nodes.find((n) => n.id === "n_inner_a") as FunctionNode).config
      .outputType,
    "InnerRenamed",
  );
  assert.equal(next.schemas, ir.schemas, "root schemas keep identity");
});
