# Phase 2 — Variable-Chip System: Design & Slice Plan

**Status:** architect design note (no code). The two implementing sessions build against this and
each append their own build-record ADR to [DECISIONS.md](DECISIONS.md) when they land green —
**2a → ADR-0029, 2b → ADR-0030** (next in sequence; not pre-reserved here). This doc is the
cold-start artifact the slice prompts point at; it carries the *why*, the prompts carry the *steps*.

This is **the headline feature** — the reason the project exists. A user drags a schema *field*
into an agent's prompt and it auto-wires as a source-bound input rendered `<Schema.field from node>`.

---

## What already exists (so Phase 2 is small)

- An agent's `instruction` is a structured `InstructionTemplate { segments: (TextSegment |
  VarSegment)[] }` ([packages/ir/src/types.ts](../packages/ir/src/types.ts)). A `VarSegment` is
  `{ type: "var", schema, field, source }`.
- Codegen already turns segments into the exact `<schema.field from source>` string
  (`renderInstruction`, [packages/codegen/src/fragments.ts](../packages/codegen/src/fragments.ts)).
- The validator already owns the var contract — **invariant 6**, `checkVarSegment` in
  [packages/ir/src/validate.ts](../packages/ir/src/validate.ts): for each `var` segment
  `{schema, field, source}` —
  (a) `source` is a node name; (b) that node's output schema **is** `schema` (structured, not
  `str`/`null`); (c) `schema` is declared and has `field`; (d) the consuming agent's
  `inputSchemaRef` **equals** `schema`. Codes: `VAR_SOURCE_NOT_NODE`, `VAR_SOURCE_NOT_STRUCTURED`,
  `VAR_SCHEMA_MISMATCH_SOURCE`, `VAR_UNKNOWN_SCHEMA`, `VAR_FIELD_NOT_FOUND`,
  `VAR_INPUT_SCHEMA_MISMATCH`.
- Today `AgentForm` ([apps/web/src/inspector/Inspector.tsx](../apps/web/src/inspector/Inspector.tsx))
  renders the instruction **read-only** as a `<pre>` of the `<schema.field from source>` form.

So Phase 2 is purely an `apps/web` job: make the UI *produce* valid var segments. **`packages/*`
stay frozen** — no new validator codes, no codegen changes. The UI never re-implements invariant 6;
`validate()` + the Preview pane remain the spec.

## The single-input constraint (the design's spine)

Because `inputSchemaRef` is one value and invariant-6 clause (d) forces it to equal *every* var's
`schema`, **an agent can reference variables from exactly one schema** — and since ADK data flow is
positional (one `node_input` per node), that schema is the agent's single upstream input. This is
not a limitation to fight; it is the rail the whole UX rides on (it becomes the palette filter in 2b).

---

## Decisions

1. **Two slices: 2a (editor) then 2b (insert + wire).** 2a makes the prompt *editable* and
   round-trips the existing segment model with **no new IR mutations**. 2b adds field insertion and
   the single auto-wire. Splitting keeps each slice to one hard problem and lets 2a ship a
   fully-tested bridge before any auto-mutation logic exists.

2. **Segments↔Lexical = two PURE functions over Lexical's serializable JSON; the React editor is a
   thin shell.** This is the ADR-0022 reducer posture applied to the editor. New module
   `apps/web/src/inspector/segmentsBridge.ts` exports:
   - `segmentsToEditorState(segments): SerializedEditorState`
   - `editorStateToSegments(state): InstructionSegment[]`

   operating on **plain JSON object literals** matching what `VariableNode.exportJSON()` emits.
   **The bridge must NOT `import "lexical"`** — every existing web test imports only IR types + node
   builtins and runs under `node --test` with **no `npm install`**; the bridge must keep that
   posture. Only the React component (`VariableEditor`) imports `lexical`.

3. **Chips are `VariableNode extends TextNode` in `"token"` mode** (Lexical's atomic-text mode):
   inline, styled, caret can't enter, one backspace deletes the whole chip. Carries
   `{schema, field, source}` in serialized state. (Lexical's "mentions" example uses a TextNode
   subclass for inline atomic chips; DecoratorNode is heavier and block-ish.)

4. **2b's only auto-mutation is `inputSchemaRef`.** Inserting a field sets, in the *same* store
   action, `agent.config.inputSchemaRef = schema` when not already equal. One focused mutation, one
   undo step. We do **not** silently rewrite or delete existing chips.

5. **Single-schema rail in the palette.** The insert palette offers `{source, schema, field}` drawn
   from producer nodes whose output is a *structured schema*. Once an agent has any var chip
   (schema A locked), the palette **filters to schema A only** — no mixing. With no chips yet, all
   candidate schemas are offered and the first insert locks `inputSchemaRef`. (Rail keys off the
   schema of *existing chips*; an agent with `inputSchemaRef` set but no chips is offered all
   schemas — a deliberately tolerated corner.)

6. **No schema mutation in 2b.** Chips consume *existing* fields of *existing* structured producers.
   A schema/field authoring UI is a separate future slice. The earlier phrase "may mutate the
   producer's `output_schema`" is **deferred** — it's only needed to invent new fields, which 2b
   does not do.

7. **No auto-edge / no topology mutation from a prompt edit.** Inserting a chip does not create a
   `source → agent` edge. Invariant 6 doesn't require one. If the chosen `source` is not actually an
   upstream producer of this agent, the value won't flow at runtime (positional dataflow) — surfaced
   as a **UI advisory only**, computed from `ir.edges` in the inspector. Deliberately **not** a new
   validator code (would touch frozen `packages/*`); v1 accepts the gap, flagged in the UI.

8. **Insert UX: click-to-insert-at-caret is the primary, reliable path.** Drag-and-drop is an
   enhancement that may be deferred within 2b if DnD caret placement proves flaky. Both end in the
   same `editor.update(() => $insertNodes([$createVariableNode(...)]))` + the `inputSchemaRef` patch.

---

## Traps (the "notes for driving this")

- **TRAP — Lexical editorState becoming a second source of truth (the echo of ADR-0026's
  "React-Flow-owns-edges").** The editor holds `editorState`; the IR must stay the source of truth.
  If the component re-seeds the editor from `segments` on every render, you get a feedback loop:
  `onChange → updateNodeConfig → store update → AgentForm re-render → re-seed → onChange …` that
  fights the caret. **Fix:** seed the editor from `segments` **once per node** (remount via
  `key={node.id}` so switching nodes re-seeds, but edits within a node don't); the editor is the
  local authority while editing that node and *pushes* changes out via `onChange → dispatch`; the
  IR is **not** pulled back into the editor except on node switch. If a diff re-seeds on every
  render, that's the thing to push back on.

- **TRAP — the bridge importing `lexical`.** If `segmentsBridge.ts` imports `lexical`, the
  cold-checkout `node --test` breaks (needs install), silently undoing the install-free posture held
  since ADR-0011/0022. The bridge operates on plain JSON only; only the React component imports
  `lexical`. Check the bridge's import list in the diff.

- **TRAP (2b) — palette click blurs the editor and collapses the selection.** Clicking a palette
  button moves focus out of the contenteditable, so "insert at caret" has no caret. **Fix:** capture
  the editor's last selection (or fall back to inserting at the end of the prompt) so the chip lands
  where the user expects.

- **Edge cases the round-trip test must cover:** newlines inside a `TextSegment` value (round-trip
  `\n`); an empty prompt (`segments: []` or a single empty text segment) → valid empty editor and
  back; adjacent text segments coalesce; a chip at the very start and at the very end.

---

## Slice plan (summary; full prompts live with the architect)

- **Slice 2a — editable prompt + pure bridge.** Add `lexical` + `@lexical/react` to
  `apps/web/package.json`. Add `segmentsBridge.ts` (pure, no `lexical` import) + headless round-trip
  test. Add `VariableNode` + `VariableEditor`. Replace the read-only `<pre>` in `AgentForm` with
  `VariableEditor`, dispatching one `updateNodeConfig(node.id, { instruction })` on change.
  **No `inputSchemaRef` touch, no insertion.** → ADR-0029.

- **Slice 2b — drag/insert field + auto-wire.** Insert palette (candidate `{source, schema, field}`
  from structured producers, single-schema rail). Click-to-insert at caret → insert chip + set
  `inputSchemaRef` in one action (new pure helper, e.g. `insertVariable(ir, agentId, ref): GraphIR`,
  headless-tested: result `compile()`s and emits `<schema.field from source>`). DnD as enhancement.
  UI advisory when `source` isn't upstream. → ADR-0030.

## Consequences

After 2a + 2b the builder delivers its headline promise end-to-end. Schema authoring, auto-edge
inference, and non-adjacent (session-`state`) variables remain explicitly deferred. Draw.io import
(Phase 3) is then the last major v1 piece.
