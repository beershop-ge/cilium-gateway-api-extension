import { Div, Span } from "@k8slens/element-components";
import { AddIcon, CloseIcon, DeleteIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { type ReactNode, useState } from "react";
import type { Json, Path } from "../common/json";
import { Callout, FieldLabel, Section } from "../ui/components";
import styles from "./gateway.module.scss";
import { type GatewayIssue, issuesUnder } from "./validation";

export { styles as gatewayStyles };

const firstError = (issues: readonly GatewayIssue[], path: Path | undefined) =>
  path ? issuesUnder(issues, path).find((issue) => issue.severity === "error")?.message : undefined;

export interface TextFieldProps {
  readonly label: ReactNode;
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly help?: ReactNode;
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly issues?: readonly GatewayIssue[];
  readonly path?: Path;
  readonly className?: string;
}

export const TextField = ({ label, value, onChange, placeholder, help, required, readOnly, issues = [], path, className = styles.grow }: TextFieldProps) => (
  <div className={className}>
    <FieldLabel label={label} required={required} help={help} error={firstError(issues, path)}>
      <TextInput aria-label={typeof label === "string" ? label : undefined} value={value ?? ""} placeholder={placeholder} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
    </FieldLabel>
  </div>
);

/** A number input that hands back `undefined` when emptied, so the field is removed rather than set to 0. */
export const NumberField = ({
  label,
  value,
  onChange,
  placeholder,
  help,
  required,
  issues = [],
  path,
  className = styles.narrow,
  min,
  max,
}: Omit<TextFieldProps, "value" | "onChange"> & { value: number | undefined; onChange: (value: number | undefined) => void; min?: number; max?: number }) => (
  <div className={className}>
    <FieldLabel label={label} required={required} help={help} error={firstError(issues, path)}>
      <TextInput
        type="number"
        aria-label={typeof label === "string" ? label : undefined}
        value={value === undefined ? "" : String(value)}
        placeholder={placeholder}
        min={min}
        max={max}
        onChange={(event) => {
          const text = event.target.value.trim();

          onChange(text === "" || Number.isNaN(Number(text)) ? undefined : Number(text));
        }}
      />
    </FieldLabel>
  </div>
);

/** Edits a list of strings, such as hostnames, one per row. */
export const StringListEditor = ({
  values,
  onChange,
  ariaLabel,
  placeholder,
  validate,
}: {
  values: readonly string[] | undefined;
  onChange: (values: string[]) => void;
  ariaLabel: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}) => {
  const [draft, setDraft] = useState("");
  const list = values ?? [];
  const draftError = draft ? (validate?.(draft) ?? (list.includes(draft) ? "Already in the list" : undefined)) : undefined;

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }} role="group" aria-label={ariaLabel}>
      {list.length === 0 && <Span $color="textMuted">None</Span>}
      {list.map((value, index) => (
        <Div key={index} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
          <Div $flexChild>
            <TextInput aria-label={`${ariaLabel} ${index + 1}`} value={value} onChange={(event) => onChange(list.map((item, position) => (position === index ? event.target.value.trim() : item)))} />
          </Div>
          <PlainButton Icon={CloseIcon} $tooltip={`Remove ${value}`} $onClick={() => onChange(list.filter((_, position) => position !== index))}>
            <Span $visuallyHidden>Remove {value}</Span>
          </PlainButton>
        </Div>
      ))}
      <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "top" }}>
        <Div $flexChild $flex={{ direction: "vertical" }}>
          <TextInput
            aria-label={`New ${ariaLabel}`}
            placeholder={placeholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value.trim())}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft && !draftError) {
                onChange([...list, draft]);
                setDraft("");
              }
            }}
          />
          {draftError && (
            <Span $color="critical" $font={{ size: "xs" }}>
              {draftError}
            </Span>
          )}
        </Div>
        <PlainButton
          Icon={AddIcon}
          $enabled={draft !== "" && !draftError}
          $onClick={() => {
            onChange([...list, draft]);
            setDraft("");
          }}
        >
          Add
        </PlainButton>
      </Div>
    </Div>
  );
};

export const RemoveButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <PlainButton Icon={DeleteIcon} $tooltip={label} $onClick={onClick}>
    <Span $visuallyHidden>{label}</Span>
  </PlainButton>
);

export const AddButton = ({ children, onClick, enabled = true, tooltip }: { children: ReactNode; onClick: () => void; enabled?: boolean; tooltip?: string }) => (
  <PlainButton Icon={AddIcon} $onClick={onClick} $enabled={enabled} $tooltip={tooltip}>
    {children}
  </PlainButton>
);

export const Card = ({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) => (
  <div className={styles.card}>
    {(title || actions) && (
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Span $font={{ bold: true }} $flexChild>
          {title}
        </Span>
        {actions}
      </Div>
    )}
    {children}
  </div>
);

export const SubCard = ({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) => (
  <div className={styles.subCard}>
    {(title || actions) && (
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Span $font={{ size: "s", bold: true }} $flexChild>
          {title}
        </Span>
        {actions}
      </Div>
    )}
    {children}
  </div>
);

export const Row = ({ children }: { children: ReactNode }) => <div className={styles.row}>{children}</div>;

/** Issues found among the references of the resource, with a fix offered where there is one. */
export const ReferenceChecks = ({ issues, onCreateGrant }: { issues: readonly GatewayIssue[]; onCreateGrant?: (grant: Json) => void }) => {
  const shown = issues.filter((issue) => issue.severity !== "info");
  const notes = issues.filter((issue) => issue.severity === "info");

  return (
    <Section title="Reference checks">
      {shown.length === 0 ? (
        <Callout level="success">Every reference resolves against what this cluster holds now.</Callout>
      ) : (
        shown.map((issue, index) => (
          <Callout key={index} level={issue.severity === "error" ? "danger" : "warning"}>
            <Div $flex={{ direction: "vertical", gap: "xs" }}>
              <span>{issue.message}</span>
              {issue.grant && onCreateGrant && (
                <Div>
                  <PlainButton Icon={AddIcon} $onClick={() => onCreateGrant(issue.grant)}>
                    Create a ReferenceGrant for this
                  </PlainButton>
                </Div>
              )}
            </Div>
          </Callout>
        ))
      )}
      {notes.map((issue, index) => (
        <Span key={`note-${index}`} $color="textMuted" $font={{ size: "s" }}>
          {issue.message}
        </Span>
      ))}
    </Section>
  );
};

export const InlineIssues = ({ issues }: { issues: readonly GatewayIssue[] }) => (
  <>
    {issues
      .filter((issue) => issue.severity !== "info")
      .map((issue, index) => (
        <Span key={index} $color={issue.severity === "error" ? "critical" : "warning"} $font={{ size: "s" }}>
          {issue.message}
        </Span>
      ))}
  </>
);
