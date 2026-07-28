/**
 * Python editor for a function/tool/router `body` (ADR-0056).
 *
 * Replaces the plain `<textarea>` the three body fields used to share. Two
 * things it adds beyond highlighting:
 *
 * 1. **The signature is shown, not guessed.** A body is the inside of a def
 *    whose header codegen writes — the author has to know that `node_input` is
 *    in scope and what the body must return. That header is derived from the
 *    IR here and rendered read-only above the editor, so the contract is
 *    visible while typing instead of discoverable only from generated output.
 * 2. **Commit on blur**, following `NodeNameInput` (ADR-0036). A body is
 *    re-validated and re-compiled on every store write; committing per
 *    keystroke would run the whole pipeline against half-typed Python and
 *    flash findings that are not real.
 *
 * Theming rides the app's CSS custom properties (`--code-*`, `--ink-*`), so
 * both `vellum` and `bathory` follow without a second theme definition.
 */
import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * Highlight colors resolve through `var(--…)`, so a theme switch repaints the
 * editor with no JS involvement. Deliberately a small palette — this is a
 * ~10-line function body, not an IDE.
 */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)" },
  { tag: tags.controlKeyword, color: "var(--accent)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--ok)" },
  { tag: tags.comment, color: "var(--ink-faint)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--landing-red)" },
  { tag: tags.function(tags.variableName), color: "var(--ink)" },
  { tag: tags.propertyName, color: "var(--ink)" },
]);

const theme = EditorView.theme({
  "&": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    color: "var(--code-ink)",
    background: "var(--code-bg)",
    border: "1px solid var(--line-strong)",
    borderRadius: "0 0 var(--r-sm) var(--r-sm)",
    borderTop: "none",
  },
  "&.cm-focused": { outline: "none", borderColor: "var(--accent)" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--accent)" },
  ".cm-gutters": {
    background: "transparent",
    border: "none",
    color: "var(--ink-faint)",
    paddingRight: "4px",
  },
  ".cm-activeLine": { background: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    background: "var(--selection-bg)",
  },
  ".cm-scroller": { lineHeight: "1.55", overflow: "auto" },
});

export interface BodyEditorProps {
  /** Current IR body; `null` means "no body — codegen emits a TODO stub". */
  readonly value: string | null | undefined;
  /** Called on blur with the new body, `null` when emptied (IR `body` semantics). */
  readonly onCommit: (next: string | null) => void;
  /** The def header codegen will write around this body. */
  readonly signature: string;
  /** What the body has to return, in words. */
  readonly returns: string;
}

export function BodyEditor({ value, onCommit, signature, returns }: BodyEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Read through a ref so the blur handler never closes over a stale prop.
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const initial = useRef(value ?? "");

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          // `indentWithTab` last: it must win over the default Tab binding,
          // which moves focus. In a code box Tab means indent.
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          python(),
          syntaxHighlighting(highlight),
          indentUnit.of("    "),
          EditorView.lineWrapping,
          theme,
          EditorView.domEventHandlers({
            blur: (_event, v) => {
              const next = v.state.doc.toString();
              commit.current(next.trim() === "" ? null : next);
              return false;
            },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  return (
    <div className="body-editor">
      <div className="body-editor__sig" aria-hidden="true">
        {signature}
      </div>
      <div ref={host} className="body-editor__cm" />
      <div className="field__hint">
        {returns} — empty ⇒ null (codegen emits a TODO stub)
      </div>
    </div>
  );
}
