/**
 * Install-required `VariableNode` tests against the real Lexical runtime
 * (ADR-0031). This file is deliberately NOT under `apps/web/test/` so the
 * default `node --test "test/**\/*.test.ts"` glob — the cold-checkout gate
 * (ADR-0011 / ADR-0013) — never picks it up. Run via `npm run test:web:app`
 * from the repo root, after `npm install` inside `apps/web/`.
 *
 * The first test is the `907dea2` regression: `VariableNode`'s constructor
 * must not call the mutating `setMode("token")`, because on an *attached*
 * node Lexical's `getWritable()` recurses `clone() → new VariableNode(...) →
 * setMode() → getWritable() → ...` and blows the stack on the first chip
 * delete. The pure bridge tests under `apps/web/test/` cannot see this — the
 * whole code path is gated behind `import "lexical"`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createHeadlessEditor } from "@lexical/headless";
import {
  $getRoot,
  $insertNodes,
  $isElementNode,
  type LexicalNode,
} from "lexical";

import type {
  AgentNode,
  GraphIR,
  InstructionSegment,
} from "@graphical-agents/ir";

import {
  $createVariableNode,
  $isVariableNode,
  VariableNode,
} from "../src/inspector/VariableNode.ts";
import {
  editorStateToSegments,
  segmentsToEditorState,
  type SerializedEditorState,
} from "../src/inspector/segmentsBridge.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cityTimePath = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "ir",
  "fixtures",
  "city-time.ir.json",
);

function loadReportSegments(): InstructionSegment[] {
  const ir = JSON.parse(readFileSync(cityTimePath, "utf8")) as GraphIR;
  const report = ir.nodes.find((n) => n.id === "n_report") as AgentNode;
  return report.config.instruction.segments;
}

/**
 * Make a headless editor that captures errors. Lexical wraps update
 * callbacks and forwards thrown errors to `onError`; we collect them so the
 * test can assert "no error fired" rather than relying on the throw
 * propagating past `editor.update` (which it does not, in headless mode).
 */
function makeEditor() {
  const errors: Error[] = [];
  const editor = createHeadlessEditor({
    namespace: "ga-variable-node-dom-test",
    nodes: [VariableNode],
    onError: (error: Error) => {
      errors.push(error);
    },
  });
  return { editor, errors };
}

function seed(
  editor: ReturnType<typeof createHeadlessEditor>,
  segments: readonly InstructionSegment[],
): void {
  const json = JSON.stringify(segmentsToEditorState(segments));
  const state = editor.parseEditorState(json);
  editor.setEditorState(state);
}

/** Walk the editor's tree and collect every attached `VariableNode`. */
function collectVariableNodes(): VariableNode[] {
  const out: VariableNode[] = [];
  const walk = (node: LexicalNode): void => {
    if ($isVariableNode(node)) out.push(node);
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) walk(child);
    }
  };
  walk($getRoot());
  return out;
}

test("907dea2 regression — removing an attached chip does not recurse", () => {
  const { editor, errors } = makeEditor();
  const segments = loadReportSegments();
  seed(editor, segments);

  let initialCount = 0;
  editor.read(() => {
    initialCount = collectVariableNodes().length;
  });
  // The city-time report agent fixture has exactly two chips.
  assert.equal(initialCount, 2);

  // Always-safe path: insert a *fresh* chip. The detached node resolves
  // its writable as `this`, so this would work even with the buggy
  // constructor — included so the test's pre-bug-trigger setup is honest.
  editor.update(
    () => {
      $getRoot().selectEnd();
      $insertNodes([
        $createVariableNode({
          schema: "CityTime",
          field: "city",
          source: "lookup_time",
        }),
      ]);
    },
    { discrete: true },
  );

  // The bug path: in a *separate* update, mutate/remove an attached chip.
  // `.remove()` triggers `getWritable()` → `clone()` → the recursive
  // constructor call when `setMode` lives in the ctor. Pre-907dea2 this
  // throws RangeError synchronously inside the update; Lexical catches it
  // and forwards to `onError`.
  editor.update(
    () => {
      const chips = collectVariableNodes();
      chips[0].remove();
    },
    { discrete: true },
  );

  assert.deepEqual(
    errors.map((e) => e.message),
    [],
    "no errors should be forwarded to onError",
  );

  // We started with 2 chips, added 1, removed 1 → 2 remain.
  let finalCount = 0;
  editor.read(() => {
    finalCount = collectVariableNodes().length;
  });
  assert.equal(finalCount, 2);
});

test("real Lexical round-trip — bridge JSON parses and re-exports cleanly", () => {
  const { editor, errors } = makeEditor();
  const segments = loadReportSegments();
  seed(editor, segments);

  // This is the half the pure bridge test cannot prove: that the
  // bridge's SerializedEditorState shape is actually accepted by
  // Lexical's parser AND that the round-trip back through
  // `editor.getEditorState().toJSON()` produces the same segments. A
  // silent Lexical-version shift in the base TextNode JSON shape would
  // surface here as a diff.
  const exported = editor.getEditorState().toJSON();
  const back = editorStateToSegments(
    exported as unknown as SerializedEditorState,
  );
  assert.deepEqual(back, segments);
  assert.equal(errors.length, 0);
});

test("token mode preserved across attached-node clone", () => {
  const { editor, errors } = makeEditor();
  seed(editor, loadReportSegments());

  // Force a clone of an attached chip by calling `getWritable()` on it
  // inside an update. Pre-907dea2 this would also recurse; post-fix it
  // produces a writable clone — and the test pins that `__mode` survives
  // the clone (Lexical's `$cloneWithProperties` copies it for TextNodes;
  // a future change that loses the copy fails loud here).
  editor.update(
    () => {
      const [chip] = collectVariableNodes();
      chip.getWritable();
    },
    { discrete: true },
  );

  let modeAfterClone: string | undefined;
  editor.read(() => {
    const [chip] = collectVariableNodes();
    modeAfterClone = chip.getMode();
  });

  assert.equal(modeAfterClone, "token");
  assert.equal(errors.length, 0);
});
