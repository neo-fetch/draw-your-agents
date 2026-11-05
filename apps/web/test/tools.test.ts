/**
 * Headless oracle for the tool-library reducers (ADR-0059).
 *
 * Sibling of `schemas.test.ts`. Pins the root-only CRUD, the rename / delete
 * cascades into agent `tools[]` and each loop role's `tools[]` at every
 * nesting depth, and the picker's toggle ordering — then round-trips the
 * results through the real validator + both codegen targets. Install-free
 * (ADR-0011 / ADR-0013 / ADR-0022 / ADR-0032): IR types, validator, codegen,
 * Node builtins only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentNode, GraphIR, LoopNode, WorkflowNode } from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/index.ts";
import { cloneFixture } from "../src/store/irReducer.ts";
import {
  addTool,
  addToolParam,
  deleteTool,
  deleteToolParam,
  renameTool,
  toggleToolRef,
  toolLibrary,
  toolSignature,
  toolTypeCandidates,
  updateTool,
  updateToolParam,
} from "../src/store/tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function load(name: string): GraphIR {
  return cloneFixture(
    JSON.parse(readFileSync(join(fixturesDir, `${name}.ir.json`), "utf8")) as GraphIR,
  );
}

const loopOf = (ir: GraphIR): LoopNode => ir.nodes.find((n) => n.type === "loop") as LoopNode;

test("addTool appends a valid starter tool with a name free of tools and nodes", () => {
  const ir = load("city-time");
  assert.equal(ir.tools, undefined);
  const { ir: next, toolName } = addTool(ir);
  assert.equal(toolName, "tool1");
  assert.equal(toolLibrary(next).length, 1);
  assert.deepEqual(validate(next).errors, [], "starter tool must validate");
  const again = addTool(next);
  assert.equal(again.toolName, "tool2");
  assert.equal(ir.tools, undefined, "pure: input untouched");
});

test("renameTool cascades into loop roles and agents; leaves other refs alone", () => {
  const ir = load("critic-loop");
  const next = renameTool(ir, "check_python_syntax", "lint_python");
  assert.deepEqual(toolLibrary(next).map((t) => t.name), ["lint_python"]);
  const loop = loopOf(next);
  assert.deepEqual(loop.config.critic.tools, ["lint_python"]);
  assert.deepEqual(loop.config.reviser.tools, ["lint_python"]);
  assert.equal(loop.config.generator.tools, undefined, "role without tools stays absent");
  assert.deepEqual(validate(next).errors, []);
  assert.match(compile(next).get("loops.py")!, /tools=\[lint_python\]/);
  assert.match(compile(next, { target: "langgraph" }).get("loops.py")!, /tools=\[lint_python\]/);
  // Pure.
  assert.deepEqual(loopOf(ir).config.critic.tools, ["check_python_syntax"]);
});

test("renameTool reaches agents inside nested workflows", () => {
  const ir = load("showcase-all-nodes");
  const wf = ir.nodes.find((n) => n.type === "workflow") as WorkflowNode;
  const inner = wf.config.graph.nodes.find((n) => n.type === "function")!;
  // Turn one nested node into an agent that uses the root tool.
  const innerAgent: AgentNode = {
    id: inner.id,
    type: "agent",
    name: inner.name,
    config: {
      model: "gemini-flash-latest",
      instruction: { segments: [{ type: "text", value: "x" }] },
      tools: ["word_count"],
      outputSchemaRef: "str",
    },
  };
  wf.config.graph.nodes = wf.config.graph.nodes.map((n) => (n.id === inner.id ? innerAgent : n));

  const next = renameTool(ir, "word_count", "count_words");
  const nextWf = next.nodes.find((n) => n.type === "workflow") as WorkflowNode;
  const nextInner = nextWf.config.graph.nodes.find((n) => n.id === inner.id) as AgentNode;
  assert.deepEqual(nextInner.config.tools, ["count_words"]);
  const summarize = next.nodes.find((n) => n.name === "summarize") as AgentNode;
  assert.deepEqual(summarize.config.tools, ["count_words"]);
  assert.deepEqual(loopOf(next).config.critic.tools, ["count_words"]);
});

test("renameTool no-ops return the same reference", () => {
  const ir = load("critic-loop");
  assert.equal(renameTool(ir, "check_python_syntax", "check_python_syntax"), ir);
  assert.equal(renameTool(ir, "missing", "x"), ir);
});

test("deleteTool scrubs refs; an emptied list and library serialize to absent", () => {
  const ir = load("critic-loop");
  const next = deleteTool(ir, "check_python_syntax");
  assert.equal("tools" in next, false, "empty library dropped");
  const loop = loopOf(next);
  assert.equal("tools" in loop.config.critic, false);
  assert.equal("tools" in loop.config.reviser, false);
  assert.deepEqual(validate(next).errors, []);
  assert.equal(compile(next).has("agent_tools.py"), false);
});

test("param CRUD + updateTool round-trip through the validator and codegen", () => {
  let ir = load("tool");
  ir = addToolParam(ir, "count_sentences");
  const tool = () => toolLibrary(ir).find((t) => t.name === "count_sentences")!;
  assert.deepEqual(tool().params.map((p) => p.name), ["text", "arg1"]);
  ir = updateToolParam(ir, "count_sentences", "arg1", { name: "limit", type: "int" });
  ir = updateTool(ir, "count_sentences", { returns: "bool", body: "return len(text) < limit" });
  assert.equal(toolSignature(tool()), "def _count_sentences_impl(text: str, limit: int) -> bool:");
  assert.deepEqual(validate(ir).errors, []);
  assert.match(compile(ir).get("agent_tools.py")!, /def count_sentences\(text: str, limit: int\) -> bool:/);
  ir = deleteToolParam(ir, "count_sentences", "limit");
  assert.deepEqual(tool().params.map((p) => p.name), ["text"]);
  // Unknown targets are no-ops.
  assert.equal(addToolParam(ir, "missing"), ir);
  assert.equal(updateToolParam(ir, "count_sentences", "missing", { type: "int" }), ir);
  assert.equal(deleteToolParam(ir, "count_sentences", "missing"), ir);
  assert.equal(updateTool(ir, "missing", { description: "x" }), ir);
});

test("toggleToolRef keeps library order, keeps unknown refs, empties to undefined", () => {
  const lib = [
    { name: "a", description: "a", params: [], returns: "str" },
    { name: "b", description: "b", params: [], returns: "str" },
  ];
  assert.deepEqual(toggleToolRef(undefined, "b", lib), ["b"]);
  assert.deepEqual(toggleToolRef(["b"], "a", lib), ["a", "b"], "library order, not click order");
  assert.deepEqual(toggleToolRef(["ghost", "a"], "b", lib), ["a", "b", "ghost"]);
  assert.equal(toggleToolRef(["a"], "a", lib), undefined);
});

test("toolTypeCandidates lists every scalar then the root schemas", () => {
  const ir = load("critic-loop");
  assert.deepEqual(toolTypeCandidates(ir.schemas), [
    "str", "int", "float", "bool", "date", "datetime", "Files", "FileItem",
  ]);
});
