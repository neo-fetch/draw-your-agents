/**
 * Pure resolver for clickable validator findings (ADR-0043): map a finding's
 * `nodeId` to the top-level canvas node the click should select.
 *
 * The validator composes nested-graph finding ids as `<parentId>/.../<nodeId>`
 * (`pathPrefix` in `packages/ir/src/validate.ts`). Inner nodes don't exist on
 * the top canvas, so a nested finding resolves to its enclosing top-level
 * workflow node — the user still lands somewhere actionable (the Inspector
 * shows the nested graph's summary there).
 *
 * No DOM, no zustand — headlessly tested in `test/findingTarget.test.ts`.
 */
import type { GraphIR } from "@graphical-agents/ir";

export function resolveFindingTarget(
  nodeId: string | undefined,
  ir: GraphIR,
): string | null {
  if (!nodeId) return null;
  if (ir.nodes.some((n) => n.id === nodeId)) return nodeId;
  const slash = nodeId.indexOf("/");
  if (slash > 0) {
    const top = nodeId.slice(0, slash);
    if (ir.nodes.some((n) => n.id === top)) return top;
  }
  return null;
}
