/**
 * Toolbar — Save IR / Load IR / Download zip (ADR-0024).
 *
 * This is the browser-only UI shim. All decision logic — JSON parsing,
 * validation surfacing, filename derivation — lives in the pure helpers
 * (`store/irIO.ts`) and the codegen pipeline (`compile` + `bundleZip`),
 * both of which are headlessly tested. The component itself is a thin
 * wrapper around `Blob`, `URL.createObjectURL`, a hidden `<input
 * type=file>`, and an anchor click — none of which run under `node --test`.
 *
 * Codegen modules are imported from their specific `.ts` files (not the
 * package index) so Vite doesn't pull in `format.ts`, which top-level
 * imports `node:child_process` for the optional `black` post-process
 * (ADR-0020). The browser path skips `black`; fragments are already
 * black-shaped (ADR-0012).
 *
 * Load policy is "load-then-surface, don't gate" (ADR-0024): a malformed
 * file is rejected outright, but a well-formed-but-invalid IR is loaded
 * with a non-blocking banner that points the user at the Preview pane
 * where the validator findings already render.
 */
import { useRef, useState } from "react";
import { useIRStore } from "../store/irStore.ts";
import {
  loadIRFromText,
  serializeIR,
  suggestedSaveFilename,
  suggestedZipFilename,
} from "../store/irIO.ts";
import { EXAMPLES, loadExample } from "../store/examples.ts";
import { ThemeSwitcher } from "./ThemeSwitcher.tsx";
import { validate } from "../../../../packages/ir/src/validate.ts";
import { compile, ValidationError } from "../../../../packages/codegen/src/compile.ts";
import { bundleZip } from "../../../../packages/codegen/src/bundle.ts";

type Banner =
  | { kind: "none" }
  | { kind: "load-findings"; count: number }
  | { kind: "error"; message: string };

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function Toolbar() {
  const ir = useIRStore((s) => s.ir);
  const replaceIR = useIRStore((s) => s.replaceIR);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [banner, setBanner] = useState<Banner>({ kind: "none" });

  // One-shot validate to drive the Download-zip disabled state. The Preview
  // pane runs the same call and renders the findings — we just need the
  // pass/fail bit here.
  const errorCount = validate(ir).errors.length;
  const zipDisabled = errorCount > 0;

  const onSave = (): void => {
    const blob = new Blob([serializeIR(ir)], { type: "application/json" });
    downloadBlob(blob, suggestedSaveFilename(ir));
  };

  const onLoadClick = (): void => {
    fileInputRef.current?.click();
  };

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    // Reset the input so re-loading the same file fires `change` again.
    e.target.value = "";
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const result = loadIRFromText(text);
    if (!result.ok) {
      setBanner({ kind: "error", message: result.error });
      return;
    }
    replaceIR(result.ir);
    setBanner(
      result.findings.length > 0
        ? { kind: "load-findings", count: result.findings.length }
        : { kind: "none" },
    );
  };

  const onExampleChosen = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    // The select is controlled at value="" so it snaps back to the
    // placeholder after every pick — re-choosing the same example fires
    // `change` again (the select analog of the file-input reset above).
    const id = e.target.value;
    if (!id) return;
    const result = loadExample(id);
    if (!result.ok) {
      setBanner({ kind: "error", message: result.error });
      return;
    }
    replaceIR(result.ir);
    setBanner(
      result.findings.length > 0
        ? { kind: "load-findings", count: result.findings.length }
        : { kind: "none" },
    );
  };

  const onDownloadZip = (): void => {
    try {
      const project = compile(ir);
      const bytes = bundleZip(project, ir.name);
      // Copy into a fresh ArrayBuffer so the Blob owns its memory cleanly —
      // `bytes` is a Uint8Array view that may be tied to the bundler's buffer.
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/zip" });
      downloadBlob(blob, suggestedZipFilename(ir));
    } catch (err) {
      if (err instanceof ValidationError) {
        setBanner({
          kind: "error",
          message: `Cannot download: IR has ${err.findings.length} validation error(s). See Preview.`,
        });
      } else {
        setBanner({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  return (
    <>
      <div className="topbar">
        <div className="wordmark">
          <span className="wordmark__mark">
            graphical<span className="dot">·</span>agents
          </span>
          <span className="wordmark__tag">IR → ADK</span>
        </div>
        <div className="toolbar">
          <ThemeSwitcher />
          <span
            className={`validity ${zipDisabled ? "has-errors" : "is-valid"}`}
            title={
              zipDisabled
                ? `IR has ${errorCount} validation error(s)`
                : "IR is valid — ready to generate"
            }
          >
            {zipDisabled
              ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
              : "valid"}
          </span>
          <select
            className="example-select"
            value=""
            onChange={onExampleChosen}
            aria-label="Load example"
          >
            <option value="" disabled>
              Load example…
            </option>
            {EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={onSave}>Save IR</button>
          <button type="button" onClick={onLoadClick}>Load IR</button>
          <button
            type="button"
            className="primary"
            onClick={onDownloadZip}
            disabled={zipDisabled}
            title={zipDisabled ? `IR has ${errorCount} validation error(s)` : undefined}
          >
            Download .zip
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.agentgraph.json,application/json"
            style={{ display: "none" }}
            onChange={onFileChosen}
          />
        </div>
      </div>
      {banner.kind !== "none" && (
        <div className={`load-banner ${banner.kind}`}>
          <span>
            {banner.kind === "load-findings"
              ? `Loaded with ${banner.count} validation finding(s). See Preview.`
              : banner.message}
          </span>
          <button
            type="button"
            className="dismiss"
            aria-label="Dismiss"
            onClick={() => setBanner({ kind: "none" })}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
