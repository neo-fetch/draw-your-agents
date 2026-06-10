/**
 * Idempotence test for the `black` post-process stage (ADR-0020). Fragments
 * already emit black-shaped text (ADR-0012), so running `black` on a freshly
 * generated project must produce **zero diffs** — every `.py` byte-equal to
 * the input. If black is not installed (cold checkout, CI without the dep),
 * the suite is skipped to honor the graceful-degrade contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphIR } from "@graphical-agents/ir";
import { generateProject } from "../src/project.ts";
import { generateLangGraphProject } from "../src/langgraph/project.ts";
import { formatProject } from "../src/format.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const blackAvailable =
  spawnSync("python3", ["-c", "import black"], { stdio: "ignore" }).status === 0;

const PROJECTS = [
  { name: "city-time", fixture: "packages/ir/fixtures/city-time.ir.json" },
  { name: "routing", fixture: "packages/ir/fixtures/routing.ir.json" },
  { name: "parallel", fixture: "packages/ir/fixtures/parallel.ir.json" },
  { name: "human-input", fixture: "packages/ir/fixtures/human-input.ir.json" },
  { name: "nested", fixture: "packages/ir/fixtures/nested.ir.json" },
  { name: "tool", fixture: "packages/ir/fixtures/tool.ir.json" },
];

function loadIR(relPath: string): GraphIR {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as GraphIR;
}

test("formatProject degrades gracefully when black is unavailable", () => {
  // The graceful-degrade contract is the same shape regardless of whether
  // black is installed: a successful format and an unavailable format both
  // return a project value, never throw. We exercise the `skip` option here
  // because it does not depend on environment state.
  const generated = generateProject(loadIR(PROJECTS[0]!.fixture));
  const { project, status } = formatProject(generated, { black: "skip" });
  assert.equal(status, "skipped");
  assert.deepEqual([...project.entries()], [...generated.entries()]);
});

// The LangGraph target leans on f-strings and magic trailing commas — the
// riskiest black surfaces — so its idempotence loop covers every fixture,
// including the loop-node and showcase projects (ADR-0045).
const LANGGRAPH_PROJECTS = [
  ...PROJECTS,
  { name: "nested-schema", fixture: "packages/ir/fixtures/nested-schema.ir.json" },
  { name: "critic-loop", fixture: "packages/ir/fixtures/critic-loop.ir.json" },
  { name: "showcase-all-nodes", fixture: "packages/ir/fixtures/showcase-all-nodes.ir.json" },
];

if (!blackAvailable) {
  test("black idempotence on goldens (skipped — black not installed)", { skip: true }, () => {});
} else {
  const TARGETS = [
    { label: "adk", projects: PROJECTS, generate: generateProject },
    { label: "langgraph", projects: LANGGRAPH_PROJECTS, generate: generateLangGraphProject },
  ];
  for (const { label, projects, generate } of TARGETS) {
    for (const { name, fixture } of projects) {
      test(`${label} ${name}: black is a no-op on the generated project`, () => {
        const generated = generate(loadIR(fixture));
        const { project, status } = formatProject(generated);
        assert.equal(status, "formatted");
        assert.deepEqual(
          [...project.keys()].sort(),
          [...generated.keys()].sort(),
          "format must not add or drop entries",
        );
        for (const [path, before] of generated) {
          assert.equal(
            project.get(path),
            before,
            `${path}: black changed bytes — fragments and black are out of sync`,
          );
        }
      });
    }
  }
}
