import { Div, Span } from "@k8slens/element-components";
import { AddIcon, CloseIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { useState } from "react";

export interface KeyValueEditorProps {
  readonly value: Readonly<Record<string, string>> | undefined;
  readonly onChange: (next: Record<string, string> | undefined) => void;
  readonly ariaLabel: string;
  readonly readOnly?: boolean;
  readonly keyPlaceholder?: string;
  readonly validateKey?: (key: string) => string | undefined;
}

const labelKeyPattern = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

export const labelKeyError = (key: string) => (labelKeyPattern.test(key) ? undefined : "Not a valid label key");

/** Edits a string map such as labels or annotations; an emptied map is removed rather than left as `{}`. */
export const KeyValueEditor = ({ value, onChange, ariaLabel, readOnly, keyPlaceholder = "key", validateKey }: KeyValueEditorProps) => {
  const entries = Object.entries(value ?? {});
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const keyError = newKey ? (validateKey?.(newKey) ?? (value?.[newKey] !== undefined ? "Already set" : undefined)) : undefined;

  const set = (next: Record<string, string>) => onChange(Object.keys(next).length === 0 ? undefined : next);

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }} role="group" aria-label={ariaLabel}>
      {entries.length === 0 && <Span $color="textMuted">None</Span>}
      {entries.map(([key, entryValue]) => (
        <Div key={key} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
          <Span $width={{ width: "10xl" }} $font={{ size: "s" }} $style={{ overflowWrap: "anywhere" }}>
            {key}
          </Span>
          <Div $flexChild>
            <TextInput aria-label={`Value of ${key}`} value={entryValue} readOnly={readOnly} onChange={(event) => set({ ...(value ?? {}), [key]: event.target.value })} />
          </Div>
          {!readOnly && (
            <PlainButton
              Icon={CloseIcon}
              $tooltip={`Remove ${key}`}
              $onClick={() => {
                const { [key]: _removed, ...rest } = value ?? {};

                set(rest);
              }}
            >
              <Span $visuallyHidden>Remove {key}</Span>
            </PlainButton>
          )}
        </Div>
      ))}
      {!readOnly && (
        <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "top" }}>
          <Div $width={{ width: "10xl" }} $flex={{ direction: "vertical" }}>
            <TextInput aria-label={`New ${ariaLabel} key`} placeholder={keyPlaceholder} value={newKey} onChange={(event) => setNewKey(event.target.value.trim())} />
            {keyError && (
              <Span $color="critical" $font={{ size: "xs" }}>
                {keyError}
              </Span>
            )}
          </Div>
          <Div $flexChild>
            <TextInput aria-label={`New ${ariaLabel} value`} placeholder="value" value={newValue} onChange={(event) => setNewValue(event.target.value)} />
          </Div>
          <PlainButton
            Icon={AddIcon}
            $enabled={newKey !== "" && !keyError}
            $onClick={() => {
              set({ ...(value ?? {}), [newKey]: newValue });
              setNewKey("");
              setNewValue("");
            }}
          >
            Add
          </PlainButton>
        </Div>
      )}
    </Div>
  );
};
