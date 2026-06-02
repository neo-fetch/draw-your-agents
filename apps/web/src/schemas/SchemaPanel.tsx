/**
 * SchemaPanel — graphical CRUD over `ir.schemas` (ADR-0035).
 *
 * Thin React shell over the pure reducers in `store/schemas.ts`. The store is
 * the only writer; validator findings (identifier validity, uniqueness,
 * dangling refs after deleteSchema) flow through Preview as usual.
 *
 * Closes the schema-authoring gap deferred by ADR-0029 decision 6 / ADR-0030:
 * a user can now create schemas + fields graphically, then point a producer's
 * outputType at one to make its fields available as variable chips.
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { ScalarType, SchemaDef } from "@graphical-agents/ir";
import { useIRStore } from "../store/irStore.ts";
import { scalarTypes } from "../store/schemas.ts";

const ROW: CSSProperties = { marginBottom: 8 };

function NameInput({
  initial,
  ariaLabel,
  onCommit,
}: {
  initial: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  // Local buffer so an in-flight name (e.g. "Schem") doesn't dispatch a
  // rename for every keystroke — the parade of invalid-identifier findings
  // mid-type would be noisy. Commit on blur / Enter. Parents key on the
  // current name, so a successful rename remounts this with a fresh initial.
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value !== initial) onCommit(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setValue(initial);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function FieldRow({
  schemaName,
  field,
}: {
  schemaName: string;
  field: { name: string; type: ScalarType; optional?: boolean };
}) {
  const updateField = useIRStore((s) => s.updateField);
  const deleteField = useIRStore((s) => s.deleteField);
  return (
    <div className="schema-field-row">
      <NameInput
        initial={field.name}
        ariaLabel={`field name ${schemaName}.${field.name}`}
        onCommit={(next) => updateField(schemaName, field.name, { name: next })}
      />
      <select
        aria-label={`field type ${schemaName}.${field.name}`}
        value={field.type}
        onChange={(e) =>
          updateField(schemaName, field.name, {
            type: e.target.value as ScalarType,
          })
        }
      >
        {scalarTypes().map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <label className="schema-field-opt" title="optional (Optional[…] = None)">
        <input
          type="checkbox"
          checked={!!field.optional}
          onChange={(e) =>
            updateField(schemaName, field.name, { optional: e.target.checked })
          }
        />
        opt
      </label>
      <button
        type="button"
        aria-label={`delete field ${schemaName}.${field.name}`}
        title="remove field"
        onClick={() => deleteField(schemaName, field.name)}
        className="schema-x"
      >
        ✕
      </button>
    </div>
  );
}

function SchemaCard({ schema }: { schema: SchemaDef }) {
  const renameSchema = useIRStore((s) => s.renameSchema);
  const deleteSchema = useIRStore((s) => s.deleteSchema);
  const addField = useIRStore((s) => s.addField);

  return (
    <div className="schema-card">
      <div className="schema-card__head">
        <NameInput
          initial={schema.name}
          ariaLabel={`schema name ${schema.name}`}
          onCommit={(next) => renameSchema(schema.name, next)}
        />
        <button
          type="button"
          aria-label={`delete schema ${schema.name}`}
          title="delete schema"
          onClick={() => deleteSchema(schema.name)}
          className="schema-x"
        >
          ✕
        </button>
      </div>
      <div className="schema-card__fields">
        {schema.fields.map((f) => (
          <FieldRow key={f.name} schemaName={schema.name} field={f} />
        ))}
      </div>
      <button
        type="button"
        className="schema-add-field"
        onClick={() => addField(schema.name)}
      >
        + field
      </button>
    </div>
  );
}

export function SchemaPanel() {
  const schemas = useIRStore((s) => s.ir.schemas);
  const addSchema = useIRStore((s) => s.addSchema);
  return (
    <div className="schema-panel">
      <div style={ROW}>
        <button type="button" className="schema-add" onClick={() => addSchema()}>
          + Schema
        </button>
      </div>
      {schemas.length === 0 ? (
        <div className="schema-empty">
          No schemas. Add one to make its fields available as variable chips on
          downstream agents.
        </div>
      ) : (
        <div className="schema-list">
          {schemas.map((s) => (
            <SchemaCard key={s.name} schema={s} />
          ))}
        </div>
      )}
    </div>
  );
}
