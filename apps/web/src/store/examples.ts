/**
 * Example gallery (ADR-0042) — the valid IR fixtures from `packages/ir`,
 * loadable from the toolbar. Static JSON imports with import attributes
 * (the `irStore.ts` precedent) work under both Vite and `node --test`;
 * `import.meta.glob` is Vite-only and would break the headless suite.
 *
 * `loadExample` funnels through `loadIRFromText` so the gallery shares the
 * exact Load IR code path (same parse guard, same load-then-surface policy)
 * and gets a deep clone for free — repeat loads never alias store state.
 *
 * The coverage guard in `test/examples.test.ts` keeps this list in lockstep
 * with `packages/ir/fixtures/*.ir.json`.
 */
import { loadIRFromText, type LoadResult } from "./irIO.ts";
import cityTime from "../../../../packages/ir/fixtures/city-time.ir.json" with { type: "json" };
import routing from "../../../../packages/ir/fixtures/routing.ir.json" with { type: "json" };
import routingContinue from "../../../../packages/ir/fixtures/routing-continue.ir.json" with { type: "json" };
import parallel from "../../../../packages/ir/fixtures/parallel.ir.json" with { type: "json" };
import parallelMid from "../../../../packages/ir/fixtures/parallel-mid.ir.json" with { type: "json" };
import tool from "../../../../packages/ir/fixtures/tool.ir.json" with { type: "json" };
import humanInput from "../../../../packages/ir/fixtures/human-input.ir.json" with { type: "json" };
import nested from "../../../../packages/ir/fixtures/nested.ir.json" with { type: "json" };
import nestedSchema from "../../../../packages/ir/fixtures/nested-schema.ir.json" with { type: "json" };
import criticLoop from "../../../../packages/ir/fixtures/critic-loop.ir.json" with { type: "json" };
import showcaseAllNodes from "../../../../packages/ir/fixtures/showcase-all-nodes.ir.json" with { type: "json" };
import stateVars from "../../../../packages/ir/fixtures/state-vars.ir.json" with { type: "json" };

export interface Example {
  /** Fixture filename stem — `<id>.ir.json` under `packages/ir/fixtures/`. */
  readonly id: string;
  /** Human-friendly dropdown label. */
  readonly label: string;
  readonly raw: unknown;
}

export const EXAMPLES: readonly Example[] = [
  { id: "city-time", label: "City time (sequence)", raw: cityTime },
  { id: "routing", label: "Support router (branch)", raw: routing },
  { id: "routing-continue", label: "Router branch continuation", raw: routingContinue },
  { id: "parallel", label: "Parallel fan-out + join", raw: parallel },
  { id: "parallel-mid", label: "Mid-graph fan-out + join", raw: parallelMid },
  { id: "tool", label: "Tool node", raw: tool },
  { id: "human-input", label: "Human input", raw: humanInput },
  { id: "nested", label: "Nested workflow", raw: nested },
  { id: "nested-schema", label: "Nested schemas (order)", raw: nestedSchema },
  { id: "critic-loop", label: "Critic loop", raw: criticLoop },
  { id: "showcase-all-nodes", label: "Showcase: every node type", raw: showcaseAllNodes },
  { id: "state-vars", label: "Session-state variables", raw: stateVars },
];

/** Load an example by id through the Load IR path. Unknown id → `ok: false`. */
export function loadExample(id: string): LoadResult {
  const example = EXAMPLES.find((e) => e.id === id);
  if (!example) return { ok: false, error: `Unknown example: ${id}` };
  return loadIRFromText(JSON.stringify(example.raw));
}
