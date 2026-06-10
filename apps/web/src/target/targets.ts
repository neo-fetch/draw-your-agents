/**
 * Codegen-target registry — framework-free on purpose: no zustand, no DOM,
 * no React, so the install-free `test/targets.test.ts` can import it under
 * bare `node --test` (same posture as `theme/themes.ts`).
 *
 * The id union is `CodegenTarget` from `packages/codegen/src/compile.ts` —
 * consumed type-only so it erases at runtime and this module keeps zero
 * runtime imports. The ids ARE compile()'s contract: a registry entry whose
 * id codegen doesn't know would silently fall back to ADK.
 */
import type { CodegenTarget } from "../../../../packages/codegen/src/compile.ts";

export type { CodegenTarget };

export interface TargetMeta {
  id: CodegenTarget;
  /** Human name shown on the landing half. */
  label: string;
  /** Toolbar tag, e.g. "IR → ADK". */
  tag: string;
  /** One-line subtitle under the landing logo. */
  blurb: string;
}

export const TARGETS: readonly TargetMeta[] = [
  {
    id: "adk",
    label: "Google ADK",
    tag: "IR → ADK",
    blurb: "Graph-workflow project for Google ADK 2.0",
  },
  {
    id: "langgraph",
    label: "LangGraph",
    tag: "IR → LangGraph",
    blurb: "StateGraph project for LangGraph 1.x",
  },
];

export const TARGET_BY_ID: ReadonlyMap<CodegenTarget, TargetMeta> = new Map(
  TARGETS.map((t) => [t.id, t]),
);

export const DEFAULT_TARGET: CodegenTarget = "adk";

/** Narrow arbitrary input to a known target id. */
export function coerceTarget(value: unknown): CodegenTarget {
  return TARGETS.some((t) => t.id === value)
    ? (value as CodegenTarget)
    : DEFAULT_TARGET;
}
