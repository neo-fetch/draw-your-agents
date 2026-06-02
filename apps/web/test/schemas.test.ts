/**
 * Headless oracle for the schema-CRUD reducer family (ADR-0035).
 *
 * Closes the schema-authoring gap deferred by ADR-0029 decision 6 / ADR-0030.
 * Pins six pure reducers against the same install-free posture as the rest of
 * the reducer family (ADR-0011 / ADR-0013 / ADR-0022 / ADR-0032): only IR
 * types, the validator, codegen, and Node builtins. Stays in `test/**` per
 * ADR-0032 so the default `npm test` runs from a cold checkout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  AgentNode,
  FunctionNode,
  GraphIR,
  VarSegment,
} from "@graphical-agents/ir";
import { validate } from "../../../packages/ir/src/validate.ts";
import { compile } from "../../../packages/codegen/src/index.ts";
import { cloneFixture } from "../src/store/irReducer.ts";
import {
  addField,
  addSchema,
  deleteField,
  deleteSchema,
  renameSchema,
  updateField,
} from "../src/store/schemas.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "packages", "ir", "fixtures");

function loadCityTime(): GraphIR {
  return JSON.parse(readFileSync(join(fixturesDir, "city-time.ir.json"), "utf8")) as GraphIR;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- addSchema -----------------------------------------------------------

test("addSchema mints a unique valid identifier with one default field", () => {
  const ir = cloneFixture(loadCityTime());
  const { ir: next, schemaName } = addSchema(ir);
  assert.match(schemaName, IDENT_RE);
  assert.ok(
    !ir.schemas.some((s) => s.name === schemaName),
    "name must not collide with existing schemas",
  );
  const fresh = next.schemas.find((s) => s.name === schemaName)!;
  assert.strictEqual(fresh.fields.length, 1, "starts populated to avoid `pass` body");
  assert.deepStrictEqual(fresh.fields[0], { name: "field1", type: "str" });

  // Two adds mint distinct names.
  const { schemaName: second } = addSchema(next);
  assert.notStrictEqual(second, schemaName);
});

test("addSchema → point a function outputType at it → validate clean + reaches schemas.py", () => {
  const ir = cloneFixture(loadCityTime());
  const { ir: withSchema, schemaName } = addSchema(ir);

  // Point n_lookup's outputType at the new schema (was "CityTime"). Need to
  // strip the city_report agent's chips + inputSchemaRef so the type ref isn't
  // pulled out from under invariant 6.
  const pointed: GraphIR = {
    ...withSchema,
    nodes: withSchema.nodes.map((n) => {
      if (n.id === "n_lookup" && n.type === "function") {
        return { ...n, config: { ...n.config, outputType: schemaName } };
      }
      if (n.id === "n_report" && n.type === "agent") {
        return {
          ...n,
          config: {
            ...n.config,
            inputSchemaRef: schemaName,
            instruction: { segments: [{ type: "text", value: "report" }] },
          },
        };
      }
      return n;
    }),
  };

  const result = validate(pointed);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));

  const schemasPy = compile(pointed).get("schemas.py") ?? "";
  assert.ok(
    schemasPy.includes(`class ${schemaName}(BaseModel):`),
    "codegen must emit the new pydantic model",
  );
  assert.ok(schemasPy.includes("field1: str"), "default field reaches schemas.py");
});

// --- renameSchema cascade -------------------------------------------------

test("renameSchema cascades to function outputType, agent inputSchemaRef, and var-chip schema", () => {
  // city-time has all three: n_lookup.outputType = "CityTime",
  // n_report.inputSchemaRef = "CityTime", and two var chips with schema="CityTime".
  const ir = cloneFixture(loadCityTime());
  const next = renameSchema(ir, "CityTime", "PlaceTime");

  // (1) schema renamed in ir.schemas
  assert.ok(next.schemas.some((s) => s.name === "PlaceTime"));
  assert.ok(!next.schemas.some((s) => s.name === "CityTime"));

  // (2) function outputType cascaded
  const lookup = next.nodes.find((n) => n.id === "n_lookup") as FunctionNode;
  assert.strictEqual(lookup.config.outputType, "PlaceTime");

  // (3) agent inputSchemaRef cascaded
  const report = next.nodes.find((n) => n.id === "n_report") as AgentNode;
  assert.strictEqual(report.config.inputSchemaRef, "PlaceTime");

  // (4) every var chip's schema cascaded
  const chips = report.config.instruction.segments.filter(
    (s) => s.type === "var",
  ) as VarSegment[];
  assert.ok(chips.length >= 2, "city-time fixture seeds multiple chips");
  for (const c of chips) assert.strictEqual(c.schema, "PlaceTime");

  // (5) validator stays clean — no dangling refs anywhere
  const result = validate(next);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));

  // (6) codegen emits the new source-bound form
  const agentsPy = compile(next).get("agents.py") ?? "";
  assert.ok(
    agentsPy.includes("<PlaceTime.time_info from lookup_time>"),
    "renamed schema reaches the rendered prompt",
  );
  assert.ok(
    !agentsPy.includes("CityTime"),
    "no stale CityTime reference in agents.py",
  );
});

test("renameSchema is a no-op when newName === oldName", () => {
  const ir = cloneFixture(loadCityTime());
  const next = renameSchema(ir, "CityTime", "CityTime");
  assert.strictEqual(next, ir, "returns the same IR reference");
});

test("renameSchema is a no-op when oldName isn't a declared schema", () => {
  const ir = cloneFixture(loadCityTime());
  const next = renameSchema(ir, "Nope", "Whatever");
  assert.strictEqual(next, ir);
});

// --- deleteSchema honest-surface -----------------------------------------

test("deleteSchema leaves dangling references for the validator to surface", () => {
  const ir = cloneFixture(loadCityTime());
  const next = deleteSchema(ir, "CityTime");

  // Schema is gone…
  assert.ok(!next.schemas.some((s) => s.name === "CityTime"));
  // …but the refs are still in the IR (honest-surface).
  const lookup = next.nodes.find((n) => n.id === "n_lookup") as FunctionNode;
  assert.strictEqual(lookup.config.outputType, "CityTime");
  const report = next.nodes.find((n) => n.id === "n_report") as AgentNode;
  assert.strictEqual(report.config.inputSchemaRef, "CityTime");

  const result = validate(next);
  // We don't re-implement the rule — just assert SOMETHING fires for the dangling refs.
  const codes = new Set(result.errors.map((f) => f.code));
  assert.ok(
    codes.has("FUNCTION_UNKNOWN_OUTPUT_TYPE") ||
      codes.has("UNKNOWN_OUTPUT_SCHEMA_REF") ||
      codes.has("VAR_UNKNOWN_SCHEMA") ||
      codes.has("UNKNOWN_INPUT_SCHEMA_REF"),
    `expected a dangling-ref finding, got: ${JSON.stringify([...codes])}`,
  );
});

test("deleteSchema is a no-op on unknown schema", () => {
  const ir = cloneFixture(loadCityTime());
  const next = deleteSchema(ir, "Nope");
  assert.strictEqual(next, ir);
});

// --- field CRUD reaches codegen ------------------------------------------

test("addField appends `field{N}: str` and the new field reaches schemas.py", () => {
  const ir = cloneFixture(loadCityTime());
  const next = addField(ir, "CityTime");
  const schema = next.schemas.find((s) => s.name === "CityTime")!;
  assert.strictEqual(schema.fields.length, 3, "city-time CityTime has 2 fields + the new one");
  const fresh = schema.fields[schema.fields.length - 1]!;
  assert.match(fresh.name, /^field\d+$/);
  assert.strictEqual(fresh.type, "str");

  const schemasPy = compile(next).get("schemas.py") ?? "";
  assert.ok(schemasPy.includes(`${fresh.name}: str`));
});

test("updateField changes type → schemas.py annotation; sets optional → Optional[...] = None", () => {
  // Strip chips so a field rename / type change doesn't trip invariant 6
  // (field-name renames deliberately do NOT cascade into var chips — the
  // validator surfaces VAR_FIELD_NOT_FOUND honestly; we test the codegen flow
  // here, not the invariant).
  const base = cloneFixture(loadCityTime());
  let ir: GraphIR = {
    ...base,
    nodes: base.nodes.map((n) => {
      if (n.id !== "n_report" || n.type !== "agent") return n;
      return {
        ...n,
        config: {
          ...n.config,
          inputSchemaRef: null,
          instruction: { segments: [{ type: "text", value: "report" }] },
        },
      };
    }),
  };

  // Type change: time_info: str → int
  ir = updateField(ir, "CityTime", "time_info", { type: "int" });
  let schemasPy = compile(ir).get("schemas.py") ?? "";
  assert.ok(schemasPy.includes("time_info: int"));
  assert.ok(!schemasPy.includes("time_info: str"));

  // optional=true → Optional[int] = None
  ir = updateField(ir, "CityTime", "time_info", { optional: true });
  schemasPy = compile(ir).get("schemas.py") ?? "";
  assert.ok(
    schemasPy.includes("time_info: Optional[int] = None"),
    `optional=true must render Optional[...] = None: ${schemasPy}`,
  );

  // optional=false clears the flag
  ir = updateField(ir, "CityTime", "time_info", { optional: false });
  schemasPy = compile(ir).get("schemas.py") ?? "";
  assert.ok(!schemasPy.includes("Optional["));
  assert.ok(schemasPy.includes("time_info: int"));

  // Name change reaches schemas.py
  ir = updateField(ir, "CityTime", "time_info", { name: "minute_info" });
  schemasPy = compile(ir).get("schemas.py") ?? "";
  assert.ok(schemasPy.includes("minute_info: int"));
});

test("deleteField removes the field from schemas.py", () => {
  const ir = cloneFixture(loadCityTime());
  // Drop the chip referencing the field first so codegen can still run.
  const cleared: GraphIR = {
    ...ir,
    nodes: ir.nodes.map((n) => {
      if (n.id !== "n_report" || n.type !== "agent") return n;
      return {
        ...n,
        config: {
          ...n.config,
          instruction: {
            segments: n.config.instruction.segments.filter(
              (s) => !(s.type === "var" && s.field === "city"),
            ),
          },
        },
      };
    }),
  };
  const next = deleteField(cleared, "CityTime", "city");
  const schema = next.schemas.find((s) => s.name === "CityTime")!;
  assert.ok(!schema.fields.some((f) => f.name === "city"));

  const schemasPy = compile(next).get("schemas.py") ?? "";
  assert.ok(!schemasPy.includes("city: "));
  assert.ok(schemasPy.includes("time_info: str"));
});

test("updateField / deleteField / addField are no-ops on unknown schema or field", () => {
  const ir = cloneFixture(loadCityTime());
  assert.strictEqual(addField(ir, "Nope"), ir);
  assert.strictEqual(deleteField(ir, "CityTime", "nope"), ir);
  assert.strictEqual(deleteField(ir, "Nope", "city"), ir);
  assert.strictEqual(updateField(ir, "Nope", "x", { type: "int" }), ir);
  assert.strictEqual(updateField(ir, "CityTime", "nope", { type: "int" }), ir);
});

// --- purity --------------------------------------------------------------

test("all six reducers leave the input IR + sibling identity untouched", () => {
  const ir = cloneFixture(loadCityTime());
  const snapshotSchemas = ir.schemas;
  const snapshotSchema0 = ir.schemas[0];
  const snapshotNodes = ir.nodes;
  const siblingNode = ir.nodes.find((n) => n.id === "n_city_gen")!; // not referenced by addField

  // addSchema
  const a = addSchema(ir).ir;
  assert.notStrictEqual(a, ir);
  assert.notStrictEqual(a.schemas, snapshotSchemas);
  assert.strictEqual(a.schemas[0], snapshotSchema0, "existing schema kept identity");

  // renameSchema cascades, so nodes referencing the schema are rebuilt — but
  // unaffected siblings (city_generator, completed_message) preserve identity.
  const r = renameSchema(ir, "CityTime", "PlaceTime");
  assert.notStrictEqual(r, ir);
  assert.strictEqual(
    r.nodes.find((n) => n.id === "n_city_gen"),
    siblingNode,
    "city_generator has no CityTime ref → identity preserved",
  );

  // deleteSchema, addField, updateField, deleteField
  const d = deleteSchema(ir, "CityTime");
  assert.notStrictEqual(d, ir);
  assert.strictEqual(d.nodes, snapshotNodes, "node list untouched by schema-only edits");

  const af = addField(ir, "CityTime");
  assert.notStrictEqual(af, ir);
  assert.strictEqual(af.nodes, snapshotNodes);

  const uf = updateField(ir, "CityTime", "city", { type: "int" });
  assert.notStrictEqual(uf, ir);
  assert.strictEqual(uf.nodes, snapshotNodes);

  const df = deleteField(ir, "CityTime", "city");
  assert.notStrictEqual(df, ir);
  assert.strictEqual(df.nodes, snapshotNodes);

  // Original IR is untouched throughout.
  assert.strictEqual(ir.schemas, snapshotSchemas);
  assert.strictEqual(ir.schemas[0], snapshotSchema0);
  assert.strictEqual(ir.schemas[0]!.fields.length, 2);
});
