/**
 * Pure save/load helpers for the IR store (ADR-0024).
 *
 * Save format = the bare `GraphIR` JSON (ADR-0001: the IR is the source of
 * truth — no wrapper envelope). Load is *parse-guard + load-then-surface*:
 * malformed JSON / non-object payloads are rejected; an IR that parses but
 * fails `validate` still loads, so the user can fix it via the inspector and
 * Preview (which already render findings).
 *
 * No DOM, no zustand, no Blob — just text in / text + findings out. The
 * browser-only file-input and anchor-click code lives in `Toolbar.tsx` (the
 * untested UI shim). Mirrors the `irReducer.ts` / `irStore.ts` split from
 * ADR-0022 so `node --test` can exercise this from a cold checkout (no
 * `npm install`, no React tree).
 */
import type { GraphIR } from "@graphical-agents/ir";
// Value import stays on the relative path (type-only imports may use the
// package name) so this module loads under install-free `node --test`.
import { IR_VERSION } from "../../../../packages/ir/src/types.ts";
import { validate, type Finding } from "../../../../packages/ir/src/validate.ts";

/**
 * A fresh, empty document for the toolbar's "New" action (ADR-0044).
 * Deliberately not valid yet — an empty graph has no START edge, and the
 * validator says so (honest-surface posture, ADR-0024); the canvas empty
 * state guides the user to their first node.
 */
export function blankIR(): GraphIR {
  return {
    irVersion: IR_VERSION,
    name: "untitled",
    schemas: [],
    nodes: [],
    edges: [],
  };
}

export type LoadResult =
  | { ok: true; ir: GraphIR; findings: Finding[] }
  | { ok: false; error: string };

/** Serialize an IR for download. Pretty-printed for human-readable diffs. */
export function serializeIR(ir: GraphIR): string {
  return JSON.stringify(ir, null, 2);
}

/**
 * Parse a `.agentgraph.json` file's text into an IR, surfacing validation
 * findings without gating the load.
 *
 * Rejects:
 *   - malformed JSON (parse error);
 *   - non-object payloads (number / string / null / array);
 *   - structurally-malformed objects missing the three array fields the
 *     canvas, inspector, and preview iterate over (`nodes`, `edges`,
 *     `schemas`). Anything without these arrays would crash the renderer
 *     on `replaceIR`, defeating the load-then-surface policy — the user
 *     can't fix what they can't see.
 *
 * Accepts (load-then-surface):
 *   - a structurally-shaped object that fails `validate` semantically
 *     (broken var refs, missing models, undeclared schemas, …). The
 *     findings are returned in `result.findings` for the load banner;
 *     Preview + Inspector still render so the user can fix the graph.
 */
export function loadIRFromText(text: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Could not parse JSON: ${msg}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "File is not a Graph IR object" };
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of ["nodes", "edges", "schemas"] as const) {
    if (!Array.isArray(obj[field])) {
      return { ok: false, error: `File is not a Graph IR object: '${field}' must be an array` };
    }
  }
  // validate() never throws — semantic errors (bad refs, missing prompts,
  // …) surface as findings; the IR loads so the user can fix them in the
  // inspector while the banner + Preview render the findings list.
  const result = validate(parsed as GraphIR);
  return { ok: true, ir: parsed as GraphIR, findings: result.findings };
}

/** `<ir.name>.agentgraph.json`, with a `graph` fallback when name is missing. */
export function suggestedSaveFilename(ir: GraphIR): string {
  return `${safeName(ir)}.agentgraph.json`;
}

/** `<ir.name>.zip`, with the same `graph` fallback. */
export function suggestedZipFilename(ir: GraphIR): string {
  return `${safeName(ir)}.zip`;
}

function safeName(ir: GraphIR): string {
  const n = (ir as { name?: unknown }).name;
  return typeof n === "string" && n.length > 0 ? n : "graph";
}
