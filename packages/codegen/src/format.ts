/**
 * Post-process formatter — the `format (black)` stage of the codegen pipeline
 * (ARCHITECTURE.md §5 / ADR-0003). `compile(ir)` stays pure and returns the
 * unformatted `GeneratedProject`; callers compose `compile() → formatProject()`
 * explicitly. The goldens pin the pre-format output, and ADR-0012 guarantees
 * fragments already emit black-shaped text — so this stage is idempotent on a
 * clean codegen (asserted by `format.test.ts`).
 *
 * `black` has no JS port. We shell out to `python3 -m black --quiet -`
 * (stdin → stdout), the same shell-out posture used by the `py_compile` trust
 * gate in `project.test.ts`. If `python3` or the `black` module is missing we
 * **degrade gracefully**: the project is returned unchanged with
 * `status: "unavailable"` and a single `console.warn` — never thrown. This
 * keeps a cold checkout's `npm test` green without `pip install black`.
 */
import { spawnSync } from "node:child_process";
import type { GeneratedProject } from "./project.ts";

export type FormatStatus = "formatted" | "skipped" | "unavailable";

export interface FormatResult {
  readonly project: GeneratedProject;
  readonly status: FormatStatus;
}

export interface FormatOptions {
  /** "auto" probes for black and uses it if present; "skip" returns the input unchanged. */
  readonly black?: "auto" | "skip";
}

let probeCache: boolean | undefined;
let warnedUnavailable = false;

/** Probe once whether `python3 -m black` can run. Cached for the process. */
function blackAvailable(): boolean {
  if (probeCache !== undefined) return probeCache;
  const res = spawnSync("python3", ["-c", "import black"], { stdio: "ignore" });
  probeCache = res.status === 0;
  return probeCache;
}

/**
 * Run `black` on every `.py` entry in `project`. Non-`.py` entries pass through
 * untouched. Returns a fresh map; the input is never mutated.
 */
export function formatProject(
  project: GeneratedProject,
  opts: FormatOptions = {},
): FormatResult {
  if (opts.black === "skip") {
    return { project: new Map(project), status: "skipped" };
  }
  if (!blackAvailable()) {
    if (!warnedUnavailable) {
      console.warn(
        "[codegen] black is not installed (python3 -m black) — skipping format. " +
          "Install via `pip install black` to enable the post-process step.",
      );
      warnedUnavailable = true;
    }
    return { project: new Map(project), status: "unavailable" };
  }

  const out: GeneratedProject = new Map();
  for (const [path, content] of project) {
    if (!path.endsWith(".py")) {
      out.set(path, content);
      continue;
    }
    const res = spawnSync("python3", ["-m", "black", "--quiet", "-"], {
      input: content,
      encoding: "utf8",
    });
    if (res.status !== 0) {
      throw new Error(
        `black failed on ${path} (exit ${res.status}): ${res.stderr?.toString() ?? ""}`,
      );
    }
    out.set(path, res.stdout);
  }
  return { project: out, status: "formatted" };
}
