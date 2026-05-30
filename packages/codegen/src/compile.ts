/**
 * Codegen entry pipeline (ADR-0013): validate → throw on errors → generate.
 *
 * `compile` is the gate-then-generate front door; `generateProject` stays pure
 * and does NOT re-validate (ADR-0010, ADR-0001) — the validator owns the IR
 * spec, and codegen trusts a clean IR.
 *
 * To keep codegen's tests green from a cold checkout with no `npm install`
 * (ADR-0011), the validator is imported at runtime via a relative `.ts`
 * specifier into the IR package source — not the `@graphical-agents/ir` package
 * specifier (whose `main` points at an unbuilt `dist/`). The `GraphIR` type
 * still comes from the package specifier and erases at runtime.
 */
import type { GraphIR } from "@graphical-agents/ir";
import { validate, type Finding } from "../../ir/src/validate.ts";
import { generateProject, type GeneratedProject } from "./project.ts";

/** Raised when the IR fails validation. Carries the error-severity findings. */
export class ValidationError extends Error {
  override name = "ValidationError";
  readonly findings: readonly Finding[];
  constructor(findings: readonly Finding[]) {
    super(
      `IR validation failed with ${findings.length} error(s): ` +
        findings.map((f) => `[${f.code}] ${f.message}`).join("; "),
    );
    this.findings = findings;
  }
}

/** Validate the IR, then generate the runnable ADK project. Throws on errors. */
export function compile(ir: GraphIR): GeneratedProject {
  const { errors } = validate(ir);
  if (errors.length > 0) throw new ValidationError(errors);
  return generateProject(ir);
}
