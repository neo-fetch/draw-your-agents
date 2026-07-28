#!/usr/bin/env node
/**
 * End-to-end EXECUTION harness — the first stage that runs generated projects
 * against the real Python libraries (google-adk / langgraph), not just
 * py_compile. Opt-in and NOT part of `npm test`: it needs network (pip) and,
 * for `--live`, a real GOOGLE_API_KEY (ADR: see docs/DECISIONS.md).
 *
 *   node scripts/e2e.ts [--live] [--target=adk|langgraph] [--fixture=name] [--keep]
 *
 * Pipeline per fixture × target:
 *   IR → compile() → formatProject() → stage into .e2e-work/projects/<target>/<fixture>/
 *
 * Phase A (always): run the generated pytest dry-run (test_workflow.py /
 * test_graph.py) inside a per-target venv — proves deps install, imports
 * resolve against the real libraries, and the graph constructs.
 *
 * Phase B (--live): overlay deterministic stub implementations from
 * scripts/e2e/stubs/<target>/<fixture>/ and run `python main.py` with a real
 * GOOGLE_API_KEY (from env or the repo-root .env). Only the LIVE_SUBSET runs
 * live; everything else records an explicit skip reason. Runs are paced to
 * respect AI Studio free-tier rate limits.
 *
 * Failures never stop the run — a dry-run failure is a FINDING about codegen
 * vs the real library API, and the whole point is to aggregate them. Exit is
 * non-zero iff any non-skipped cell failed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { GraphIR } from "../packages/ir/src/types.ts";
import { compile, type CodegenTarget } from "../packages/codegen/src/compile.ts";
import { formatProject } from "../packages/codegen/src/format.ts";

// ---------------------------------------------------------------- constants

const REPO = resolve(import.meta.dirname, "..");
const FIXTURES_DIR = join(REPO, "packages", "ir", "fixtures");
const STUBS_DIR = join(REPO, "scripts", "e2e", "stubs");
const WORK = join(REPO, ".e2e-work");

const TARGETS: readonly CodegenTarget[] = ["adk", "langgraph"];
const DRY_TEST_FILE: Record<CodegenTarget, string> = {
  adk: "test_workflow.py",
  langgraph: "test_graph.py",
};

/** Fixtures executed live with a real key. All use free-tier-friendly models. */
const LIVE_SUBSET = [
  // `bodies` has no agent nodes, so its live cell costs zero API calls — it is
  // pure execution proof for the ADR-0056 body wrapper. It still needs a key
  // present, because the live phase is gated once for the whole run.
  "bodies",
  "city-time",
  "routing",
  "routing-continue",
  "parallel",
  "tool",
] as const;

/** Fixtures never run live, with the recorded reason. */
const LIVE_SKIP: Record<string, string> = {
  "human-input": "requires interactive stdin (RequestInput)",
  "critic-loop": "uses gemini-2.5-pro — unreliable on the free tier",
  "showcase-all-nodes": "includes humanInput + loop; dry-run only",
};

const DRY_TIMEOUT_MS = 120_000;
const LIVE_TIMEOUT_MS = 180_000;
const LIVE_PACING_MS = 20_000; // AI Studio free tier ≈ 10 RPM
const PIP_TIMEOUT_MS = 900_000;

// ------------------------------------------------------------------ results

type Status =
  | "pass"
  | "fail"
  | "timeout"
  | "skipped"
  | "install-fail"
  | "stage-fail";

interface Cell {
  fixture: string;
  target: CodegenTarget;
  phase: "dry" | "live";
  status: Status;
  durationMs: number;
  logPath?: string;
  reason?: string;
}

const cells: Cell[] = [];

// --------------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const live = args.includes("--live");
const keep = args.includes("--keep");
const targetArg = args.find((a) => a.startsWith("--target="))?.slice(9);
const fixtureArg = args.find((a) => a.startsWith("--fixture="))?.slice(10);
if (targetArg && targetArg !== "adk" && targetArg !== "langgraph") {
  console.error("usage: node scripts/e2e.ts [--live] [--target=adk|langgraph] [--fixture=name] [--keep]");
  process.exit(2);
}
const targets = targetArg ? [targetArg as CodegenTarget] : [...TARGETS];

// ------------------------------------------------------------------ helpers

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function log(msg: string): void {
  console.log(msg);
}

interface RunResult {
  status: "pass" | "fail" | "timeout";
  output: string;
  durationMs: number;
}

/** Run a command, capture combined output, enforce a timeout. Never throws. */
function run(
  cmd: string,
  cmdArgs: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): RunResult {
  const started = Date.now();
  const res = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const output = `${res.stdout ?? ""}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ""}`;
  const timedOut = res.error != null && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const status = timedOut ? "timeout" : res.status === 0 ? "pass" : "fail";
  return { status, output, durationMs };
}

function writeLog(name: string, content: string): string {
  const path = join(WORK, "logs", `${name}.log`);
  writeFileSync(path, content);
  return path;
}

/** GOOGLE_API_KEY from the environment, falling back to the repo-root .env. */
function findApiKey(): string | undefined {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  const envFile = join(REPO, ".env");
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?GOOGLE_API_KEY\s*=\s*["']?([^"'\s#]+)/);
    if (m) return m[1];
  }
  return undefined;
}

// ------------------------------------------------------------------ staging

interface Staged {
  fixture: string;
  target: CodegenTarget;
  dir: string;
  requirements: string;
}

function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".ir.json"))
    .map((f) => basename(f, ".ir.json"))
    .filter((f) => !fixtureArg || f === fixtureArg)
    .sort();
}

function stage(fixture: string, target: CodegenTarget): Staged | undefined {
  const dir = join(WORK, "projects", target, fixture);
  try {
    const ir = JSON.parse(
      readFileSync(join(FIXTURES_DIR, `${fixture}.ir.json`), "utf8"),
    ) as GraphIR;
    const { project } = formatProject(compile(ir, { target }));
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of project) writeFileSync(join(dir, name), content);
    return {
      fixture,
      target,
      dir,
      requirements: project.get("requirements.txt") ?? "",
    };
  } catch (ex) {
    const logPath = writeLog(`${target}-${fixture}-stage`, String((ex as Error).stack ?? ex));
    cells.push({ fixture, target, phase: "dry", status: "stage-fail", durationMs: 0, logPath });
    return undefined;
  }
}

// -------------------------------------------------------------------- venvs

/** Create/reuse one venv per target; reinstall only when requirements change. */
function ensureVenv(target: CodegenTarget, staged: Staged[]): string | undefined {
  const venv = join(WORK, `venv-${target}`);
  const python = join(venv, "bin", "python");
  const reqLines = new Set<string>();
  for (const s of staged) {
    for (const line of s.requirements.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) reqLines.add(t);
    }
  }
  const reqText = [...reqLines].sort().join("\n") + "\n";
  const reqPath = join(WORK, `requirements-${target}.txt`);
  const stampPath = join(WORK, `venv-${target}.stamp`);
  const stamp = createHash("sha256").update(reqText).digest("hex");

  if (existsSync(python) && existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp) {
    log(`  venv-${target}: up to date (stamp match), skipping pip install`);
    return python;
  }

  if (!existsSync(python)) {
    log(`  venv-${target}: creating`);
    const mk = run("python3", ["-m", "venv", venv], { timeoutMs: 120_000 });
    if (mk.status !== "pass") {
      writeLog(`venv-${target}-create`, mk.output);
      return undefined;
    }
  }

  writeFileSync(reqPath, reqText);
  log(`  venv-${target}: pip install (${[...reqLines].join(", ")})`);
  const env = { ...process.env };
  const caBundle = "/root/.ccr/ca-bundle.crt";
  if (!env.PIP_CERT && existsSync(caBundle)) env.PIP_CERT = caBundle;
  const pip = run(python, ["-m", "pip", "install", "--quiet", "-r", reqPath], {
    env,
    timeoutMs: PIP_TIMEOUT_MS,
  });
  const logPath = writeLog(`venv-${target}-pip`, pip.output);
  if (pip.status !== "pass") {
    log(`  venv-${target}: pip install FAILED — see ${logPath}`);
    return undefined;
  }
  writeFileSync(stampPath, stamp);
  return python;
}

// ------------------------------------------------------------------ overlay

/** Copy committed stub files over a staged project. Returns false if none exist. */
function overlayStubs(s: Staged): boolean {
  const src = join(STUBS_DIR, s.target, s.fixture);
  if (!existsSync(src)) return false;
  for (const f of readdirSync(src)) {
    writeFileSync(join(s.dir, f), readFileSync(join(src, f), "utf8"));
  }
  return true;
}

// ------------------------------------------------------------------- phases

function runDry(python: string, s: Staged): void {
  const res = run(python, ["-m", "pytest", "-q", DRY_TEST_FILE[s.target]], {
    cwd: s.dir,
    timeoutMs: DRY_TIMEOUT_MS,
  });
  const logPath = writeLog(`${s.target}-${s.fixture}-dry`, res.output);
  cells.push({ ...cellBase(s, "dry"), status: res.status, durationMs: res.durationMs, logPath });
  log(`  [dry ] ${s.target}/${s.fixture}: ${res.status} (${(res.durationMs / 1000).toFixed(1)}s)`);
}

function runLive(python: string, s: Staged, apiKey: string, first: boolean): void {
  if (!first) sleep(LIVE_PACING_MS);
  if (!overlayStubs(s)) {
    cells.push({ ...cellBase(s, "live"), status: "fail", durationMs: 0, reason: "no stub overlay found" });
    log(`  [live] ${s.target}/${s.fixture}: fail (no stub overlay)`);
    return;
  }
  const res = run(python, ["main.py"], {
    cwd: s.dir,
    env: { ...process.env, GOOGLE_API_KEY: apiKey },
    timeoutMs: LIVE_TIMEOUT_MS,
  });
  const logPath = writeLog(`${s.target}-${s.fixture}-live`, res.output);
  cells.push({ ...cellBase(s, "live"), status: res.status, durationMs: res.durationMs, logPath });
  log(`  [live] ${s.target}/${s.fixture}: ${res.status} (${(res.durationMs / 1000).toFixed(1)}s)`);
}

function cellBase(s: Staged, phase: "dry" | "live"): Pick<Cell, "fixture" | "target" | "phase"> {
  return { fixture: s.fixture, target: s.target, phase };
}

// ------------------------------------------------------------------- report

function statusMark(c: Cell | undefined): string {
  if (!c) return "–";
  switch (c.status) {
    case "pass": return "✅ pass";
    case "fail": return "❌ fail";
    case "timeout": return "⏱ timeout";
    case "skipped": return `⏭ skip`;
    case "install-fail": return "🚫 install";
    case "stage-fail": return "🚫 stage";
  }
}

function buildReport(fixtures: string[]): string {
  const find = (f: string, t: CodegenTarget, p: "dry" | "live") =>
    cells.find((c) => c.fixture === f && c.target === t && c.phase === p);
  const cols = targets.flatMap((t) => (live ? [`${t}-dry`, `${t}-live`] : [`${t}-dry`]));
  const lines: string[] = [];
  lines.push(`# e2e run — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`| fixture | ${cols.join(" | ")} |`);
  lines.push(`|---|${cols.map(() => "---").join("|")}|`);
  for (const f of fixtures) {
    const row = targets.flatMap((t) => {
      const out = [statusMark(find(f, t, "dry"))];
      if (live) out.push(statusMark(find(f, t, "live")));
      return out;
    });
    lines.push(`| ${f} | ${row.join(" | ")} |`);
  }
  const skips = cells.filter((c) => c.status === "skipped" && c.reason);
  if (skips.length > 0) {
    lines.push("");
    lines.push("Skips:");
    const seen = new Set<string>();
    for (const c of skips) {
      const key = `${c.fixture}: ${c.reason}`;
      if (!seen.has(key)) lines.push(`- ${key}`), seen.add(key);
    }
  }
  return lines.join("\n") + "\n";
}

function printFailureDigest(): void {
  const bad = cells.filter((c) => c.status === "fail" || c.status === "timeout");
  for (const c of bad) {
    if (!c.logPath || !existsSync(c.logPath)) continue;
    const tail = readFileSync(c.logPath, "utf8").split("\n").slice(-30).join("\n");
    log(`\n───── ${c.target}/${c.fixture} [${c.phase}] ${c.status} — ${c.logPath}`);
    log(tail);
  }
}

// --------------------------------------------------------------------- main

const fixtures = listFixtures();
if (fixtures.length === 0) {
  console.error(fixtureArg ? `no fixture named "${fixtureArg}"` : "no fixtures found");
  process.exit(2);
}

if (!keep) rmSync(join(WORK, "projects"), { recursive: true, force: true });
rmSync(join(WORK, "logs"), { recursive: true, force: true });
mkdirSync(join(WORK, "logs"), { recursive: true });

log(`e2e: ${fixtures.length} fixture(s) × [${targets.join(", ")}]${live ? " + live" : ""}`);

for (const target of targets) {
  log(`\n=== target: ${target} ===`);
  const staged: Staged[] = [];
  for (const fixture of fixtures) {
    const s = stage(fixture, target);
    if (s) staged.push(s);
  }
  log(`  staged ${staged.length}/${fixtures.length} projects`);

  const python = ensureVenv(target, staged);
  if (!python) {
    for (const s of staged) {
      cells.push({ ...cellBase(s, "dry"), status: "install-fail", durationMs: 0 });
      if (live) cells.push({ ...cellBase(s, "live"), status: "install-fail", durationMs: 0 });
    }
    continue;
  }

  for (const s of staged) runDry(python, s);

  if (live) {
    const apiKey = findApiKey();
    let first = true;
    for (const s of staged) {
      if (LIVE_SKIP[s.fixture]) {
        cells.push({ ...cellBase(s, "live"), status: "skipped", durationMs: 0, reason: LIVE_SKIP[s.fixture] });
      } else if (!(LIVE_SUBSET as readonly string[]).includes(s.fixture)) {
        cells.push({ ...cellBase(s, "live"), status: "skipped", durationMs: 0, reason: "not in live subset (rate limits)" });
      } else if (!apiKey) {
        cells.push({ ...cellBase(s, "live"), status: "skipped", durationMs: 0, reason: "no GOOGLE_API_KEY (env or .env)" });
      } else {
        runLive(python, s, apiKey, first);
        first = false;
      }
    }
    if (!apiKey) log("  [live] skipped all — set GOOGLE_API_KEY or add it to <repo>/.env");
  }
}

const report = buildReport(fixtures);
writeFileSync(join(WORK, "report.md"), report);
writeFileSync(join(WORK, "report.json"), JSON.stringify(cells, null, 2) + "\n");
log("\n" + report);
printFailureDigest();

const failed = cells.filter(
  (c) => c.status !== "pass" && c.status !== "skipped",
);
log(`\ne2e: ${cells.length - failed.length}/${cells.length} cells ok — report at .e2e-work/report.md`);
process.exit(failed.length > 0 ? 1 : 0);
