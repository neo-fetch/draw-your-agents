/**
 * Segments ↔ Lexical bridge — two pure functions over plain JSON (ADR-0029).
 *
 * `InstructionTemplate.segments` (the IR shape) ↔ Lexical's
 * `SerializedEditorState` (the editor shape). Operates on plain JSON object
 * literals matching what `VariableNode.exportJSON()` emits and what
 * Lexical's `parseEditorState` accepts. **Must NOT `import "lexical"`** —
 * every existing `apps/web/test/` file runs under `node --test` with no
 * `npm install`, and this bridge is part of that install-free reducer family
 * ([ADR-0011](../../../docs/DECISIONS.md) / [ADR-0022](../../../docs/DECISIONS.md)).
 *
 * Newlines round-trip via `LineBreakNode`s within a single paragraph (the
 * PlainTextPlugin posture). Adjacent text runs coalesce into one
 * `TextSegment` on the way out; empty text drops.
 */
import type { InstructionSegment } from "@graphical-agents/ir";

// ----- minimal local types mirroring Lexical's SerializedEditorState ------
// Typed structurally so the bridge stays Lexical-free at compile time.

export interface SerializedTextNode {
  type: "text";
  text: string;
  format: number;
  detail: number;
  mode: "normal" | "token" | "segmented";
  style: string;
  version: 1;
}

export interface SerializedVariableNode {
  type: "variable";
  text: string;
  format: number;
  detail: number;
  mode: "token";
  style: string;
  version: 1;
  schema: string;
  field: string;
  source: string;
}

export interface SerializedLineBreakNode {
  type: "linebreak";
  version: 1;
}

export type SerializedInlineNode =
  | SerializedTextNode
  | SerializedVariableNode
  | SerializedLineBreakNode;

export interface SerializedParagraphNode {
  type: "paragraph";
  format: "";
  indent: 0;
  version: 1;
  direction: null;
  textFormat: 0;
  textStyle: "";
  children: SerializedInlineNode[];
}

export interface SerializedRootNode {
  type: "root";
  format: "";
  indent: 0;
  version: 1;
  direction: null;
  children: SerializedParagraphNode[];
}

export interface SerializedEditorState {
  root: SerializedRootNode;
}

// ----- shared shape factories --------------------------------------------

function textNode(text: string): SerializedTextNode {
  return {
    type: "text",
    text,
    format: 0,
    detail: 0,
    mode: "normal",
    style: "",
    version: 1,
  };
}

function lineBreak(): SerializedLineBreakNode {
  return { type: "linebreak", version: 1 };
}

/**
 * Render label for a var chip. Matches the codegen source-bound form
 * ([ADR-0008](../../../docs/DECISIONS.md)) so the on-screen chip text is
 * exactly what compiles into the agent instruction.
 */
export function varLabel(schema: string, field: string, source: string): string {
  return `<${schema}.${field} from ${source}>`;
}

function variableNode(
  schema: string,
  field: string,
  source: string,
): SerializedVariableNode {
  return {
    type: "variable",
    text: varLabel(schema, field, source),
    format: 0,
    detail: 0,
    mode: "token",
    style: "",
    version: 1,
    schema,
    field,
    source,
  };
}

function paragraph(children: SerializedInlineNode[]): SerializedParagraphNode {
  return {
    type: "paragraph",
    format: "",
    indent: 0,
    version: 1,
    direction: null,
    textFormat: 0,
    textStyle: "",
    children,
  };
}

// ----- segments → editor state -------------------------------------------

/**
 * `InstructionSegment[]` → Lexical-compatible serialized editor state.
 *
 * - Text segments split on `\n` into runs; each non-empty run becomes a
 *   text node, and every `\n` becomes a `LineBreakNode` (round-trips
 *   newlines without paragraph splits).
 * - Var segments become atomic token-mode chips carrying
 *   `{schema, field, source}`.
 * - Empty `segments` → editor state with one empty paragraph (so the
 *   editor mounts cleanly).
 */
export function segmentsToEditorState(
  segments: readonly InstructionSegment[],
): SerializedEditorState {
  const children: SerializedInlineNode[] = [];
  for (const seg of segments) {
    if (seg.type === "var") {
      children.push(variableNode(seg.schema, seg.field, seg.source));
      continue;
    }
    // text
    const value = seg.value;
    if (value === "") continue;
    const parts = value.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) children.push(lineBreak());
      if (part !== "") children.push(textNode(part));
    });
  }
  return {
    root: {
      type: "root",
      format: "",
      indent: 0,
      version: 1,
      direction: null,
      children: [paragraph(children)],
    },
  };
}

// ----- editor state → segments -------------------------------------------

/**
 * Lexical-compatible serialized editor state → `InstructionSegment[]`.
 *
 * - Walks every paragraph (defensively — RichTextPlugin upgrades may produce
 *   more than one), inserting `\n` between paragraphs.
 * - Adjacent text runs and line breaks coalesce into one `TextSegment`;
 *   empty text is dropped.
 * - `variable` nodes → `VarSegment{schema, field, source}` (reads the three
 *   fields directly from the serialized node).
 *
 * Defensive against unknown node types: anything we don't recognize is
 * skipped without crashing — keeps the editor usable across Lexical
 * upgrades that might introduce new node types we haven't taught the
 * bridge about.
 */
export function editorStateToSegments(
  state: SerializedEditorState,
): InstructionSegment[] {
  const out: InstructionSegment[] = [];
  let textRun = "";

  const flushText = () => {
    if (textRun !== "") {
      out.push({ type: "text", value: textRun });
      textRun = "";
    }
  };

  const paragraphs = state.root?.children ?? [];
  paragraphs.forEach((p, pIndex) => {
    if (pIndex > 0) textRun += "\n";
    const children = p.children ?? [];
    for (const child of children) {
      if (child.type === "text") {
        textRun += child.text;
      } else if (child.type === "linebreak") {
        textRun += "\n";
      } else if (child.type === "variable") {
        flushText();
        out.push({
          type: "var",
          schema: child.schema,
          field: child.field,
          source: child.source,
        });
      }
      // unknown types are skipped — see docblock
    }
  });
  flushText();
  return out;
}
