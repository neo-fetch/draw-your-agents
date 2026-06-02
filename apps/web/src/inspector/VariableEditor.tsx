/**
 * VariableEditor — thin Lexical shell that round-trips an
 * `InstructionTemplate.segments` array through a contenteditable (ADR-0029).
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
 */
import { useMemo } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import type { InstructionSegment } from "@graphical-agents/ir";

import { VariableNode } from "./VariableNode.ts";
import {
  editorStateToSegments,
  segmentsToEditorState,
  type SerializedEditorState,
} from "./segmentsBridge.ts";

export interface VariableEditorProps {
  segments: readonly InstructionSegment[];
  onChange: (next: InstructionSegment[]) => void;
}

export function VariableEditor({ segments, onChange }: VariableEditorProps) {
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
      </LexicalComposer>
    </div>
  );
}
