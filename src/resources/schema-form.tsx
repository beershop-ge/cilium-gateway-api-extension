import { Div, Span } from "@k8slens/element-components";
import { AddIcon, ArrowDropDownIcon, ArrowDropUpIcon, CloseIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { type ReactNode, useEffect, useState } from "react";
import { deletePath, isPlainObject, type Json, type Path, pathToString, setPath } from "../common/json";
import { parseSingleYaml, toYaml } from "../common/yaml";
import { effectiveType, emptyValueFor, resolveSchema, type Schema, type SchemaDefinitions, shortDescription } from "../schema/schema";
import type { ValidationIssue } from "../schema/validate";
import { Checkbox, Select } from "../ui/components";
import styles from "../ui/ui.module.scss";

interface FormContext {
  readonly root: Json;
  readonly onChange: (next: Json) => void;
  readonly definitions: SchemaDefinitions;
  readonly issues: ReadonlyMap<string, readonly ValidationIssue[]>;
  readonly readOnly: boolean;
}

export interface SchemaFormProps {
  /** The whole document; the form edits it in place of the paths it shows and leaves every other field alone. */
  readonly value: Json;
  readonly onChange: (next: Json) => void;
  readonly schema: Schema;
  readonly definitions?: SchemaDefinitions;
  /** Which top-level fields to show; the rest (apiVersion, kind, metadata, status) are edited elsewhere. */
  readonly fields: readonly string[];
  readonly issues?: readonly ValidationIssue[];
  readonly readOnly?: boolean;
}

const humanize = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase());

const IssueText = ({ context, path }: { context: FormContext; path: Path }) => {
  const issues = context.issues.get(pathToString(path)) ?? [];

  return (
    <>
      {issues.map((issue, index) => (
        <Span key={index} className={issue.severity === "error" ? styles.fieldError : styles.fieldWarning} $font={{ size: "xs" }}>
          {issue.message}
        </Span>
      ))}
    </>
  );
};

/** A value edited as YAML text, for schema nodes that preserve unknown fields or have no type. */
const YamlField = ({ context, path, value }: { context: FormContext; path: Path; value: Json }) => {
  const [text, setText] = useState(() => (value === undefined ? "" : toYaml(value)));
  const [error, setError] = useState<string>();

  useEffect(() => {
    setText(value === undefined ? "" : toYaml(value));
  }, [JSON.stringify(value)]);

  return (
    <Div $flex={{ direction: "vertical", gap: "xxs" }}>
      <textarea
        className={`${styles.textArea} ${styles.mono}`}
        rows={Math.min(14, Math.max(3, text.split("\n").length))}
        value={text}
        readOnly={context.readOnly}
        aria-label={`${pathToString(path)} (YAML)`}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() === "") {
            setError(undefined);
            context.onChange(deletePath(context.root, path));

            return;
          }

          const parsed = parseSingleYaml(text);

          if (parsed.error) {
            setError(parsed.error);
          } else {
            setError(undefined);
            context.onChange(setPath(context.root, path, parsed.value));
          }
        }}
      />
      {error && (
        <Span className={styles.fieldError} $font={{ size: "xs" }}>
          {error}
        </Span>
      )}
      <Span $color="textMuted" $font={{ size: "xs" }}>
        Free-form YAML; applied when the field loses focus.
      </Span>
    </Div>
  );
};

const ScalarInput = ({ context, path, schema, value, label }: { context: FormContext; path: Path; schema: Schema; value: Json; label: string }) => {
  const type = effectiveType(schema);
  const set = (next: Json) => context.onChange(next === undefined ? deletePath(context.root, path) : setPath(context.root, path, next));

  if (schema.enum && schema.enum.length > 0) {
    return (
      <Select
        ariaLabel={label}
        value={value === undefined ? undefined : String(value)}
        disabled={context.readOnly}
        placeholder="(not set)"
        options={schema.enum.map((option) => ({ value: String(option), label: String(option) }))}
        onChange={(next) => set(schema.enum!.find((option) => String(option) === next))}
      />
    );
  }

  if (type === "boolean") {
    return <Checkbox checked={value === true} disabled={context.readOnly} label={value === undefined ? "(not set)" : String(value)} onChange={(checked) => set(checked)} />;
  }

  if (type === "integer" || type === "number") {
    return (
      <TextInput
        type="number"
        aria-label={label}
        value={value === undefined || value === null ? "" : String(value)}
        readOnly={context.readOnly}
        min={schema.minimum}
        max={schema.maximum}
        step={type === "integer" ? 1 : "any"}
        placeholder={schema.default !== undefined ? `default ${schema.default}` : undefined}
        onChange={(event) => {
          const text = event.target.value;

          if (text === "") {
            set(undefined);
          } else if (!Number.isNaN(Number(text))) {
            set(Number(text));
          }
        }}
      />
    );
  }

  return (
    <TextInput
      aria-label={label}
      value={value === undefined || value === null ? "" : String(value)}
      readOnly={context.readOnly}
      placeholder={schema.default !== undefined ? `default ${schema.default}` : schema.format ?? (type === "int-or-string" ? "number or name" : undefined)}
      onChange={(event) => {
        const text = event.target.value;

        if (type === "int-or-string" && /^\d+$/.test(text)) {
          set(Number(text));
        } else {
          set(text);
        }
      }}
    />
  );
};

const RemoveButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <PlainButton Icon={CloseIcon} $onClick={onClick} $tooltip={label}>
    <Span $visuallyHidden>{label}</Span>
  </PlainButton>
);

const FieldShell = ({ label, required, schema, actions, children, context, path }: { label: string; required?: boolean; schema: Schema; actions?: ReactNode; children: ReactNode; context: FormContext; path: Path }) => (
  <Div $flex={{ direction: "vertical", gap: "xxs" }}>
    <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
      <Span $font={{ size: "s", bold: true }} $tooltip={shortDescription(schema)}>
        {label}
        {required && <Span $color="critical"> *</Span>}
      </Span>
      <Span $color="textMuted" $font={{ size: "xs" }}>
        {effectiveType(schema) === "any" ? "" : effectiveType(schema)}
      </Span>
      <Div $flexChild />
      {actions}
    </Div>
    {children}
    <IssueText context={context} path={path} />
  </Div>
);

const ObjectFields = ({ context, path, schema, value, depth }: { context: FormContext; path: Path; schema: Schema; value: Json; depth: number }) => {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const object = isPlainObject(value) ? value : {};
  const shown = Object.keys(properties).filter((key) => object[key] !== undefined || required.has(key));
  const addable = Object.keys(properties).filter((key) => object[key] === undefined && !required.has(key));
  const unknown = Object.keys(object).filter((key) => !properties[key]);
  const additional = isPlainObject(schema.additionalProperties) ? resolveSchema(schema.additionalProperties, context.definitions) : undefined;
  const [newKey, setNewKey] = useState("");

  return (
    <Div $flex={{ direction: "vertical", gap: "s" }}>
      {shown.map((key) => (
        <FieldEditor key={key} context={context} path={[...path, key]} schema={properties[key]} value={object[key]} required={required.has(key)} depth={depth + 1} label={humanize(key)} />
      ))}

      {additional &&
        unknown.map((key) => (
          <FieldEditor
            key={key}
            context={context}
            path={[...path, key]}
            schema={additional}
            value={object[key]}
            depth={depth + 1}
            label={key}
          />
        ))}

      {!additional && unknown.length > 0 && (
        <Div $flex={{ direction: "vertical", gap: "xxs" }}>
          <Span $color="textMuted" $font={{ size: "xs" }}>
            Kept as they are (not described by the schema): {unknown.join(", ")}
          </Span>
        </Div>
      )}

      {!context.readOnly && additional && (
        <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
          <TextInput aria-label="New key" placeholder="key" value={newKey} $width={{ width: "8xl" }} onChange={(event) => setNewKey(event.target.value)} />
          <PlainButton
            Icon={AddIcon}
            $enabled={newKey.trim() !== "" && object[newKey.trim()] === undefined}
            $onClick={() => {
              context.onChange(setPath(context.root, [...path, newKey.trim()], emptyValueFor(additional, context.definitions)));
              setNewKey("");
            }}
          >
            Add entry
          </PlainButton>
        </Div>
      )}

      {!context.readOnly && addable.length > 0 && (
        <Div $width={{ width: "11xl", max: "full" }}>
          <Select
            ariaLabel={`Add a field to ${pathToString(path) || "the document"}`}
            value={undefined}
            placeholder={`+ Add field (${addable.length} available)`}
            options={addable.map((key) => ({ value: key, label: `${key}${shortDescription(resolveSchema(properties[key], context.definitions)) ? ` — ${shortDescription(resolveSchema(properties[key], context.definitions))!.slice(0, 80)}` : ""}` }))}
            onChange={(key) => context.onChange(setPath(context.root, [...path, key], emptyValueFor(properties[key], context.definitions)))}
          />
        </Div>
      )}
    </Div>
  );
};

const ArrayItems = ({ context, path, schema, value, depth }: { context: FormContext; path: Path; schema: Schema; value: Json; depth: number }) => {
  const items: Json[] = Array.isArray(value) ? value : [];
  const itemSchema = resolveSchema(schema.items ?? {}, context.definitions);
  const scalar = !["object", "array", "any"].includes(effectiveType(itemSchema) ?? "any");

  const move = (from: number, to: number) => {
    const next = [...items];
    const [moved] = next.splice(from, 1);

    next.splice(to, 0, moved);
    context.onChange(setPath(context.root, path, next));
  };

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }}>
      {items.map((item, index) => (
        <Div key={index} $flex={{ direction: scalar ? "horizontal" : "vertical", gap: "xxs" }} className={scalar ? undefined : styles.formIndent}>
          {scalar ? (
            <>
              <Div $flexChild>
                <ScalarInput context={context} path={[...path, index]} schema={itemSchema} value={item} label={`${pathToString(path)} item ${index + 1}`} />
              </Div>
              {!context.readOnly && <RemoveButton label={`Remove item ${index + 1}`} onClick={() => context.onChange(deletePath(context.root, [...path, index]))} />}
            </>
          ) : (
            <>
              <Div $flex={{ direction: "horizontal", gap: "xxs", verticalAlign: "center" }}>
                <Span $color="textMuted" $font={{ size: "xs", bold: true }} $flexChild>
                  Item {index + 1}
                </Span>
                {!context.readOnly && (
                  <>
                    <PlainButton Icon={ArrowDropUpIcon} $enabled={index > 0} $onClick={() => move(index, index - 1)} $tooltip="Move up">
                      <Span $visuallyHidden>Move up</Span>
                    </PlainButton>
                    <PlainButton Icon={ArrowDropDownIcon} $enabled={index < items.length - 1} $onClick={() => move(index, index + 1)} $tooltip="Move down">
                      <Span $visuallyHidden>Move down</Span>
                    </PlainButton>
                    <RemoveButton label={`Remove item ${index + 1}`} onClick={() => context.onChange(deletePath(context.root, [...path, index]))} />
                  </>
                )}
              </Div>
              <NodeBody context={context} path={[...path, index]} schema={itemSchema} value={item} depth={depth + 1} label={`Item ${index + 1}`} />
            </>
          )}
          <IssueText context={context} path={[...path, index]} />
        </Div>
      ))}
      {!context.readOnly && (
        <Div>
          <PlainButton
            Icon={AddIcon}
            $enabled={schema.maxItems === undefined || items.length < schema.maxItems}
            $onClick={() => context.onChange(setPath(context.root, path, [...items, emptyValueFor(itemSchema, context.definitions)]))}
          >
            Add item
          </PlainButton>
        </Div>
      )}
    </Div>
  );
};

const NodeBody = ({ context, path, schema, value, depth, label }: { context: FormContext; path: Path; schema: Schema; value: Json; depth: number; label: string }) => {
  const type = effectiveType(schema);

  if (type === "object" && (schema.properties || isPlainObject(schema.additionalProperties))) {
    return <ObjectFields context={context} path={path} schema={schema} value={value} depth={depth} />;
  }

  if (type === "array") {
    return <ArrayItems context={context} path={path} schema={schema} value={value} depth={depth} />;
  }

  if (type === "object" || type === "any") {
    return <YamlField context={context} path={path} value={value} />;
  }

  return <ScalarInput context={context} path={path} schema={schema} value={value} label={label} />;
};

const FieldEditor = ({ context, path, schema: rawSchema, value, required, depth, label }: { context: FormContext; path: Path; schema: Schema; value: Json; required?: boolean; depth: number; label: string }) => {
  const schema = resolveSchema(rawSchema, context.definitions);
  const type = effectiveType(schema);
  const nested = type === "object" || type === "array";
  const remove = !context.readOnly && !required ? <RemoveButton label={`Remove ${label}`} onClick={() => context.onChange(deletePath(context.root, path))} /> : undefined;
  const hasIssues = [...context.issues.keys()].some((key) => key.startsWith(pathToString(path)));

  if (!nested) {
    return (
      <FieldShell label={label} required={required} schema={schema} actions={remove} context={context} path={path}>
        <NodeBody context={context} path={path} schema={schema} value={value} depth={depth} label={label} />
      </FieldShell>
    );
  }

  const count = Array.isArray(value) ? `${value.length} item${value.length === 1 ? "" : "s"}` : isPlainObject(value) ? `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}` : "";

  return (
    <details open={depth < 2 || hasIssues}>
      <summary style={{ cursor: "pointer" }}>
        <Span $font={{ size: "s", bold: true }} $tooltip={shortDescription(schema)}>
          {label}
          {required && <Span $color="critical"> *</Span>}
        </Span>{" "}
        <Span $color="textMuted" $font={{ size: "xs" }}>
          {count}
        </Span>{" "}
        {remove}
      </summary>
      <Div className={styles.formIndent} $padding={{ top: "xs", bottom: "xs" }} $flex={{ direction: "vertical", gap: "xs" }}>
        {shortDescription(schema) && (
          <Span $color="textMuted" $font={{ size: "xs" }}>
            {shortDescription(schema)}
          </Span>
        )}
        <NodeBody context={context} path={path} schema={schema} value={value} depth={depth} label={label} />
        <IssueText context={context} path={path} />
      </Div>
    </details>
  );
};

/** A form generated from a CRD's OpenAPI v3 schema, editing the document field by field without dropping anything it does not show. */
export const SchemaForm = ({ value, onChange, schema, definitions = {}, fields, issues = [], readOnly = false }: SchemaFormProps) => {
  const resolved = resolveSchema(schema, definitions);
  const issueMap = new Map<string, ValidationIssue[]>();

  for (const issue of issues) {
    const key = pathToString(issue.path);

    issueMap.set(key, [...(issueMap.get(key) ?? []), issue]);
  }

  const context: FormContext = { root: value, onChange, definitions, issues: issueMap, readOnly };
  const required = new Set(resolved.required ?? []);
  const shownFields = fields.filter((field) => resolved.properties?.[field]);

  if (shownFields.length === 0) {
    return (
      <Span $color="textMuted">
        This kind has no fields to edit in a form beyond its metadata. Use the YAML editor.
      </Span>
    );
  }

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }}>
      {shownFields.map((field) => (
        <FieldEditor key={field} context={context} path={[field]} schema={resolved.properties![field]} value={value?.[field]} required={required.has(field)} depth={0} label={humanize(field)} />
      ))}
    </Div>
  );
};
