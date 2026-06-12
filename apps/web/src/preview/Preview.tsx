import { useMemo, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { useIRStore } from "../store/irStore.ts";
// Import directly from compile.ts (not codegen's index) — the index re-exports
// format.ts and bundle.ts, and format.ts imports `node:child_process` at top
// level (the black shell-out, ADR-0020). Vite externalizes node built-ins for
// the browser, which would explode at runtime. Preview only needs the pure
// compile path; black formatting is opt-in and lives in later slices.
import { compile, ValidationError } from "../../../../packages/codegen/src/compile.ts";
import type { GeneratedProject } from "../../../../packages/codegen/src/project.ts";
import { resolveFindingPath } from "../store/subgraph.ts";
import { EASE_OUT, findingItem } from "../anim/presets.ts";
import type { CodegenTarget } from "../target/targets.ts";
import { useTargetStore } from "../target/targetStore.ts";

type CompileResult =
  | { kind: "ok"; project: GeneratedProject }
  | { kind: "validation"; findings: ValidationError["findings"] }
  | { kind: "error"; message: string };

function safeCompile(
  ir: Parameters<typeof compile>[0],
  target: CodegenTarget,
): CompileResult {
  try {
    return { kind: "ok", project: compile(ir, { target }) };
  } catch (e) {
    if (e instanceof ValidationError) return { kind: "validation", findings: e.findings };
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

const DEFAULT_FILE = "agents.py";

/**
 * Findings list — each row is a card; fixed findings animate out via
 * AnimatePresence so progress is visible ("drain the list" UX, ADR-0044).
 * Rows resolve to a canvas node where possible (ADR-0043) and then the
 * whole row is the focus affordance, not just a suffix link.
 */
function Findings({ findings }: { findings: ValidationError["findings"] }) {
  const ir = useIRStore((s) => s.ir);
  const focusFinding = useIRStore((s) => s.focusFinding);

  // Stable per-finding keys; duplicates (same code+node+message) get a
  // disambiguating counter so React keys stay unique.
  const seen = new Map<string, number>();
  const rows = findings.map((f) => {
    const base = `${f.code}|${f.nodeId ?? ""}|${f.message}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { f, key: n === 0 ? base : `${base}#${n}` };
  });

  const count = findings.length;
  return (
    <div>
      <div className="findings-head">
        <strong>
          {count} validation finding{count === 1 ? "" : "s"}
        </strong>
        <span className="findings-sub">fix these to export your project</span>
      </div>
      <ul className="findings">
        <AnimatePresence mode="popLayout" initial={false}>
          {rows.map(({ f, key }) => {
            // Path-prefixed nested ids ("n_outer/n_inner", ADR-0017)
            // navigate into the owning sub-graph and center the actual
            // node, instead of landing on the enclosing workflow card
            // (ADR-0050).
            const target = resolveFindingPath(ir, f.nodeId);
            const body = (
              <>
                <span className="finding-row__dot" aria-hidden="true" />
                <span className="finding-row__code">{f.code}</span>
                <span className="finding-row__msg">
                  {f.message}
                  {f.nodeId ? ` (node: ${f.nodeId})` : ""}
                </span>
              </>
            );
            return (
              <m.li
                key={key}
                layout
                variants={findingItem}
                initial="hidden"
                animate="show"
                exit="exit"
                className="finding-row"
              >
                {target ? (
                  <button
                    type="button"
                    className="finding-row__btn"
                    title="Show this node on the canvas"
                    onClick={() => focusFinding(f.nodeId!)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="finding-row__btn is-static">{body}</div>
                )}
              </m.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}

export function Preview() {
  const ir = useIRStore((s) => s.ir);
  const target = useTargetStore((s) => s.target);
  const result = useMemo(() => safeCompile(ir, target), [ir, target]);
  const [selectedFile, setSelectedFile] = useState<string>(DEFAULT_FILE);

  if (result.kind === "validation") {
    return <Findings findings={result.findings} />;
  }

  if (result.kind === "error") {
    return <div className="preview-error">Preview error: {result.message}</div>;
  }

  const files = Array.from(result.project.keys()).sort();
  const file = files.includes(selectedFile) ? selectedFile : files[0] ?? DEFAULT_FILE;
  const content = result.project.get(file) ?? "";

  return (
    <div>
      <select value={file} onChange={(e) => setSelectedFile(e.target.value)}>
        {files.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      {/* Crossfade keyed on the filename only — never animate the <pre> text
          itself (large strings re-layout). The accent bar re-runs whenever
          the compiled content changes: a quiet "refreshed" tick. */}
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={file}
          className="preview-slab"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <m.div
            key={content}
            className="preview-refresh-bar"
            aria-hidden="true"
            initial={{ scaleX: 0, opacity: 0.9 }}
            animate={{ scaleX: 1, opacity: 0 }}
            transition={{ duration: 0.7, ease: EASE_OUT }}
          />
          <pre>{content}</pre>
        </m.div>
      </AnimatePresence>
    </div>
  );
}
