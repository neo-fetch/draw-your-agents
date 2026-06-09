import { useMemo, useState } from "react";
import { useIRStore } from "../store/irStore.ts";
// Import directly from compile.ts (not codegen's index) — the index re-exports
// format.ts and bundle.ts, and format.ts imports `node:child_process` at top
// level (the black shell-out, ADR-0020). Vite externalizes node built-ins for
// the browser, which would explode at runtime. Preview only needs the pure
// compile path; black formatting is opt-in and lives in later slices.
import { compile, ValidationError } from "../../../../packages/codegen/src/compile.ts";
import type { GeneratedProject } from "../../../../packages/codegen/src/project.ts";
import { resolveFindingTarget } from "../store/findingTarget.ts";

type CompileResult =
  | { kind: "ok"; project: GeneratedProject }
  | { kind: "validation"; findings: ValidationError["findings"] }
  | { kind: "error"; message: string };

function safeCompile(ir: Parameters<typeof compile>[0]): CompileResult {
  try {
    return { kind: "ok", project: compile(ir) };
  } catch (e) {
    if (e instanceof ValidationError) return { kind: "validation", findings: e.findings };
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

const DEFAULT_FILE = "agents.py";

export function Preview() {
  const ir = useIRStore((s) => s.ir);
  const focusNode = useIRStore((s) => s.focusNode);
  const result = useMemo(() => safeCompile(ir), [ir]);
  const [selectedFile, setSelectedFile] = useState<string>(DEFAULT_FILE);

  if (result.kind === "validation") {
    return (
      <div>
        <div className="findings-head">IR validation failed</div>
        <ul className="findings">
          {result.findings.map((f, i) => {
            // Clickable when the finding's node resolves to a canvas node
            // (nested findings resolve to their enclosing workflow node —
            // ADR-0043); otherwise the suffix stays plain text.
            const target = resolveFindingTarget(f.nodeId, ir);
            return (
              <li key={i}>
                [{f.code}] {f.message}
                {f.nodeId &&
                  (target ? (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="finding-link"
                        onClick={() => focusNode(target)}
                      >
                        (node: {f.nodeId})
                      </button>
                    </>
                  ) : (
                    ` (node: ${f.nodeId})`
                  ))}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (result.kind === "error") {
    return (
      <div className="preview-error">Preview error: {result.message}</div>
    );
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
      <pre>{content}</pre>
    </div>
  );
}
