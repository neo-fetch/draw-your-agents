/**
 * VariableNode — a Lexical TextNode subclass in `"token"` mode that renders an
 * inline atomic chip for an instruction `VarSegment` (ADR-0029).
 *
 * Token-mode = Lexical's atomic-text mode: caret can't enter, one backspace
 * deletes the whole chip. The Lexical "mentions" example uses the same
 * pattern; DecoratorNode is heavier and block-ish, so we stay with
 * TextNode (see [PHASE-2-DESIGN.md](../../../../docs/PHASE-2-DESIGN.md)
 * decision 3).
 *
 * The serialized shape (`exportJSON` / `importJSON`) must match exactly what
 * `segmentsBridge.ts` emits — that bridge is the install-free oracle and
 * pins this shape via a snapshot test (`apps/web/test/segmentsBridge.test.ts`).
 */
import {
  $applyNodeReplacement,
  TextNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

import { varLabel } from "./segmentsBridge.ts";

export interface VariableNodePayload {
  schema: string;
  field: string;
  source: string;
  /** Data-flow category (ADR-0051); omitted ⇒ positional (`"input"`). */
  via?: "input" | "state";
}

export type SerializedVariableNode = Spread<
  VariableNodePayload & { type: "variable"; version: 1 },
  SerializedTextNode
>;

const VARIABLE_CHIP_CLASS = "ga-variable-chip";
const STATE_CHIP_CLASS = "ga-variable-chip--state";

export class VariableNode extends TextNode {
  /** {schema, field, source, via} — the IR fields that round-trip through the bridge. */
  __schema: string;
  __field: string;
  __source: string;
  __via?: "input" | "state";

  static getType(): string {
    return "variable";
  }

  static clone(node: VariableNode): VariableNode {
    return new VariableNode(
      {
        schema: node.__schema,
        field: node.__field,
        source: node.__source,
        via: node.__via,
      },
      node.__key,
    );
  }

  constructor(payload: VariableNodePayload, key?: NodeKey) {
    super(varLabel(payload.schema, payload.field, payload.source, payload.via), key);
    this.__schema = payload.schema;
    this.__field = payload.field;
    this.__source = payload.source;
    this.__via = payload.via;
    // NOTE: token mode is set in `$createVariableNode`, NOT here. Calling the
    // mutating `setMode()` from the constructor recurses infinitely: Lexical's
    // `clone()` (invoked when an *attached* node is edited/deleted) calls
    // `new VariableNode(...)` → `setMode()` → `getWritable()` →
    // `$cloneWithProperties()` → `clone()` → … The framework copies `__mode`
    // across clone via `$cloneWithProperties`, and `importJSON` restores it via
    // `super.updateFromJSON(serialized)`, so the constructor must stay pure.
  }

  createDOM(...args: Parameters<TextNode["createDOM"]>): HTMLElement {
    const dom = super.createDOM(...args);
    dom.classList.add(VARIABLE_CHIP_CLASS);
    if (this.__via === "state") dom.classList.add(STATE_CHIP_CLASS);
    dom.setAttribute("data-ga-schema", this.__schema);
    dom.setAttribute("data-ga-field", this.__field);
    dom.setAttribute("data-ga-source", this.__source);
    if (this.__via === "state") dom.setAttribute("data-ga-via", "state");
    return dom;
  }

  static importJSON(serialized: SerializedVariableNode): VariableNode {
    return $createVariableNode({
      schema: serialized.schema,
      field: serialized.field,
      source: serialized.source,
      via: serialized.via,
    }).updateFromJSON(serialized);
  }

  updateFromJSON(
    serialized: LexicalUpdateJSON<SerializedVariableNode>,
  ): this {
    super.updateFromJSON(serialized);
    this.__schema = serialized.schema;
    this.__field = serialized.field;
    this.__source = serialized.source;
    this.__via = serialized.via;
    return this;
  }

  exportJSON(): SerializedVariableNode {
    return {
      ...super.exportJSON(),
      type: "variable",
      version: 1,
      schema: this.__schema,
      field: this.__field,
      source: this.__source,
      ...(this.__via === "state" ? { via: this.__via } : {}),
    };
  }

  // Keep token-mode invariant intact across edits. TextNode tries to merge
  // adjacent same-style text nodes; chips must never merge with siblings.
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
  isTextEntity(): true {
    return true;
  }
}

export function $createVariableNode(payload: VariableNodePayload): VariableNode {
  // Set token mode here (not in the constructor — see the constructor note).
  // The node is freshly created and not yet attached, so `setMode` resolves
  // its writable as `this` without cloning: no recursion.
  const node = new VariableNode(payload);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isVariableNode(
  node: unknown,
): node is VariableNode {
  return node instanceof VariableNode;
}
