import { useMemo, useState } from "react";
import { useIRStore } from "../store/irStore.ts";
// Import directly from compile.ts (not codegen's index) — the index re-exports
// format.ts and bundle.ts, and format.ts imports `node:child_process` at top
// level (the black shell-out, ADR-0020). Vite externalizes node built-ins for
// the browser, which would explode at runtime. Preview only needs the pure
// compile path; black formatting is opt-in and lives in later slices.
import { compile, ValidationError } from "../../../../packages/codegen/src/compile.ts";
import type { GeneratedProject } from "../../../../packages/codegen/src/project.ts";

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
  const result = useMemo(() => safeCompile(ir), [ir]);
  const [selectedFile, setSelectedFile] = useState<string>(DEFAULT_FILE);

  if (result.kind === "validation") {
    return (
      <div>
        <div style={{ marginBottom: 6, color: "#b91c1c", fontWeight: 600 }}>
          IR validation failed
        </div>
        <ul className="findings">
          {result.findings.map((f, i) => (
            <li key={i}>
              [{f.code}] {f.message}
              {f.nodeId ? ` (node: ${f.nodeId})` : ""}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (result.kind === "error") {
    return (
      <div style={{ color: "#b91c1c" }}>
        Preview error: {result.message}
      </div>
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
