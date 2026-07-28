/**
 * Python emission helpers shared by the node template fragments (ADR-0003).
 *
 * These keep the fragments declarative: a fragment describes the imports it
 * needs and renders its own body, and the assembler ([project.ts]) dedupes the
 * imports and stitches modules together. `black` is the final formatter
 * (ADR-0003 post-process step, not run yet) — so we emit black-shaped text
 * (4-space indent, double quotes, trailing commas in multiline calls) to keep
 * the eventual reformat a no-op.
 */

/** Raised when the IR uses a construct this slice cannot generate code for. */
export class CodegenError extends Error {
  override name = "CodegenError";
}

/** A `from <module> import <names...>` request emitted by a fragment. */
export interface ImportReq {
  readonly module: string;
  readonly names: readonly string[];
}

/** Render a Python double-quoted string literal, escaping black-relevant chars. */
export function pyStr(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Strip the deepest common leading whitespace from a block, and trim blank
 * lines off both ends (ADR-0056).
 *
 * An IR `body` is authored in a text box, so it routinely arrives carrying the
 * indentation it had wherever it was copied from. `indent` prefixes a fixed pad
 * to *every* line, so without this an already-indented body compiles to Python
 * that black rejects — a failure that surfaces three stages downstream from the
 * typo. Blank lines are ignored when measuring, and never count as the
 * shallowest line.
 */
export function dedent(block: string): string {
  const lines = block.replace(/\s+$/, "").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length === 0) return "";

  let common = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    common = Math.min(common, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(common) || common === 0) return lines.join("\n");
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(common))).join("\n");
}

/** Indent every line of a block by `level` 4-space steps. */
export function indent(block: string, level = 1): string {
  const pad = "    ".repeat(level);
  return block
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

const STDLIB = new Set(["__future__", "datetime", "typing"]);
/** Local modules of the ADK target's project layout (the default). */
const LOCAL = new Set(["schemas", "agents", "functions", "loops", "workflow"]);

/** Black's default line-length budget. Used by `renderImports` to decide when to wrap. */
export const BLACK_LINE_WIDTH = 88;

/**
 * Dedupe and group imports isort-style: stdlib, third-party, local — each group
 * sorted, blank line between groups. Empty groups are dropped. Lines that
 * exceed `BLACK_LINE_WIDTH` are wrapped in parentheses, one name per line, to
 * match black's idempotent form (ADR-0020).
 *
 * `localModules` is the target's own module set (what counts as the "local"
 * group) — defaults to the ADK project layout; the LangGraph target passes its
 * own (ADR-0045).
 */
export function renderImports(
  reqs: readonly ImportReq[],
  localModules: ReadonlySet<string> = LOCAL,
): string {
  const byModule = new Map<string, Set<string>>();
  for (const req of reqs) {
    let names = byModule.get(req.module);
    if (!names) byModule.set(req.module, (names = new Set()));
    for (const name of req.names) names.add(name);
  }

  const groups: string[][] = [[], [], []]; // stdlib, third-party, local
  for (const [module, names] of byModule) {
    const sortedNames = [...names].sort();
    const inline = `from ${module} import ${sortedNames.join(", ")}`;
    const line =
      inline.length <= BLACK_LINE_WIDTH
        ? inline
        : `from ${module} import (\n${sortedNames.map((n) => `    ${n},`).join("\n")}\n)`;
    const bucket = STDLIB.has(module) ? 0 : localModules.has(module) ? 2 : 1;
    groups[bucket].push(line);
  }

  return groups
    .filter((g) => g.length > 0)
    .map((g) => g.sort().join("\n"))
    .join("\n\n");
}
