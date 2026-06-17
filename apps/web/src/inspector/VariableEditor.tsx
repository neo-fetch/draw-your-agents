/**
 * VariableEditor — thin Lexical shell that round-trips an
 * `InstructionTemplate.segments` array through a contenteditable
 * (ADR-0029) and exposes an imperative `insertVariable(ref)` API for the
 * 2b palette (ADR-0030).
 *
 * Architecture (mirrors the ADR-0022 reducer posture):
 *  - All segment ↔ editor-state shape decisions live in the pure
 *    `segmentsBridge.ts` (Lexical-free; install-free headless test pins it).
 *  - This component is the React wrapper: it seeds the editor *once per
 *    mounted node* via `initialConfig.editorState` and pushes changes back
 *    out via `OnChangePlugin → editorStateToSegments → onChange`.
 *
 * Seed-once-per-node rule (the load-bearing trap from
 * [PHASE-2-DESIGN.md](../../../../docs/PHASE-2-DESIGN.md)): `AgentForm`
 * remounts this component with `key={node.id}`, so a fresh
 * `initialConfig` runs per node. The IR is never *pulled back* into the
 * editor while editing — that would create the caret-fighting feedback
 * loop echoed from ADR-0026.
 *
 * Imperative insertion API (2b): the palette button click blurs the
 * editor and collapses the selection (PHASE-2-DESIGN trap), so an inner
 * plugin snapshots the last RangeSelection on every selection change
 * and the insert call restores it inside `editor.update`. If no saved
 * selection is available, the chip is appended at the end of the prompt
 * — the deliberate fallback.
 */
import { useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
  type BaseSelection,
} from "lexical";
import type { InstructionSegment } from "@graphical-agents/ir";

import { $createVariableNode, VariableNode } from "./VariableNode.ts";
import {
  editorStateToSegments,
  segmentsToEditorState,
  type SerializedEditorState,
} from "./segmentsBridge.ts";
import type { VariableRef } from "../store/insertVariable.ts";

export interface VariableEditorAPI {
  /**
   * Insert a chip at the editor's last-captured selection. Falls back to
   * the end of the prompt when no selection was ever made (e.g. the user
   * never focused the editor before clicking the palette). `via: "state"`
   * inserts a non-adjacent session-state chip (ADR-0051).
   */
  insertVariable: (ref: VariableRef, via?: "input" | "state") => void;
}

export interface VariableEditorProps {
  segments: readonly InstructionSegment[];
  onChange: (next: InstructionSegment[]) => void;
  /**
   * Parent-owned ref the inner plugin populates on mount so the palette
   * (which lives outside the LexicalComposer) can drive insertion
   * imperatively. The plugin must be inside the Composer to call
   * `useLexicalComposerContext`, so an exposed API ref is the bridge.
   */
  apiRef?: MutableRefObject<VariableEditorAPI | null>;
}

/**
 * Inner plugin — must live inside `<LexicalComposer>` so it can read the
 * editor + register a selection listener. Two jobs:
 *  1. Snapshot the last `RangeSelection` on every selection change so the
 *     palette-click blur doesn't lose the caret.
 *  2. Expose the `insertVariable(ref)` method via the parent-owned `apiRef`.
 */
function InsertVariablePlugin({
  apiRef,
}: {
  apiRef?: MutableRefObject<VariableEditorAPI | null>;
}): null {
  const [editor] = useLexicalComposerContext();
  const lastSelectionRef = useRef<BaseSelection | null>(null);

  useEffect(() => {
    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const sel = $getSelection();
        if ($isRangeSelection(sel)) {
          // Clone so the snapshot isn't mutated by subsequent edits.
          lastSelectionRef.current = sel.clone();
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    return unregister;
  }, [editor]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insertVariable: (ref, via) => {
        editor.update(() => {
          const saved = lastSelectionRef.current;
          if (saved !== null) {
            $setSelection(saved.clone());
          } else {
            // Fallback: no caret was ever set — append at the end.
            $getRoot().selectEnd();
          }
          $insertNodes([$createVariableNode({ ...ref, via })]);
        });
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [editor, apiRef]);

  return null;
}

export function VariableEditor({
  segments,
  onChange,
  apiRef,
}: VariableEditorProps) {
  // Seed once: the bridge produces a SerializedEditorState; we hand Lexical
  // its JSON string form, which `LexicalComposer` reads exactly once on
  // mount (see `initialConfig.editorState` docs).
  // The `key={node.id}` remount in `AgentForm` is what forces a re-seed on
  // node switch; within one node, this useMemo runs once.
  const initialEditorStateJSON = useMemo(
    () => JSON.stringify(segmentsToEditorState(segments)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed-once-per-mount
    [],
  );

  const initialConfig = useMemo(
    () => ({
      namespace: "agent-instruction",
      editorState: initialEditorStateJSON,
      nodes: [VariableNode],
      onError: (error: Error) => {
        // Surface the error during dev; don't swallow it. Lexical's
        // ErrorBoundary inside PlainTextPlugin catches render-time errors.
        console.error("[VariableEditor] Lexical error:", error);
      },
    }),
    [initialEditorStateJSON],
  );

  return (
    <div className="ga-variable-editor">
      <LexicalComposer initialConfig={initialConfig}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="ga-variable-editor__input"
              aria-placeholder="Agent instruction"
              placeholder={
                <div className="ga-variable-editor__placeholder">
                  Agent instruction
                </div>
              }
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin
          ignoreSelectionChange
          onChange={(editorState) => {
            editorState.read(() => {
              const state = editorState.toJSON() as SerializedEditorState;
              onChange(editorStateToSegments(state));
            });
          }}
        />
        <InsertVariablePlugin apiRef={apiRef} />
      </LexicalComposer>
    </div>
  );
}

