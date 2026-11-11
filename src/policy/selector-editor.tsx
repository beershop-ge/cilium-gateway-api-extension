import { Div, Span } from "@k8slens/element-components";
import { AddIcon, CloseIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { useEffect, useState } from "react";
import { Select } from "../ui/components";
import { KeyValueEditor } from "../ui/key-value-editor";
import { type SelectorModel, type SelectorOperator, selectorOperators } from "./model";

const splitList = (text: string) =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** A comma-separated list in one text box; keeps what is typed while it is being typed. */
export const ListInput = ({ value, onChange, ariaLabel, placeholder }: { value: readonly string[]; onChange: (value: string[]) => void; ariaLabel: string; placeholder?: string }) => {
  const [text, setText] = useState(value.join(", "));

  useEffect(() => {
    if (splitList(text).join(",") !== value.join(",")) {
      setText(value.join(", "));
    }
    // Only follow changes from outside, not each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.join(",")]);

  return (
    <TextInput
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(splitList(event.target.value));
      }}
    />
  );
};

/** Edits a label selector: labels to match exactly, and expressions (In, NotIn, Exists, DoesNotExist). */
export const SelectorEditor = ({ value, onChange, ariaLabel, help }: { value: SelectorModel; onChange: (value: SelectorModel) => void; ariaLabel: string; help?: string }) => (
  <Div $flex={{ direction: "vertical", gap: "xs" }} role="group" aria-label={ariaLabel}>
    <Span $font={{ size: "xs" }} $color="textMuted">
      Match labels{help ? ` — ${help}` : ""}
    </Span>
    <KeyValueEditor ariaLabel={`${ariaLabel} labels`} value={value.matchLabels} keyPlaceholder="label key (e.g. app or k8s:app)" onChange={(labels) => onChange({ ...value, matchLabels: labels ?? {} })} />
    {value.matchExpressions.length > 0 && (
      <Span $font={{ size: "xs" }} $color="textMuted">
        Match expressions
      </Span>
    )}
    {value.matchExpressions.map((expression, index) => {
      const update = (next: Partial<typeof expression>) => onChange({ ...value, matchExpressions: value.matchExpressions.map((other, at) => (at === index ? { ...other, ...next } : other)) });
      const needsValues = expression.operator === "In" || expression.operator === "NotIn";

      return (
        <Div key={index} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
          <Div $flexChild>
            <TextInput aria-label={`Expression ${index + 1} key`} placeholder="key" value={expression.key} onChange={(event) => update({ key: event.target.value.trim() })} />
          </Div>
          <Div $width={{ width: "8xl" }}>
            <Select<SelectorOperator> ariaLabel={`Expression ${index + 1} operator`} value={expression.operator} options={selectorOperators.map((operator) => ({ value: operator, label: operator }))} onChange={(operator) => update({ operator })} />
          </Div>
          <Div $flexChild>
            {needsValues ? (
              <ListInput ariaLabel={`Expression ${index + 1} values`} placeholder="values, comma separated" value={expression.values} onChange={(values) => update({ values })} />
            ) : (
              <Span $color="textMuted" $font={{ size: "s" }}>
                no values
              </Span>
            )}
          </Div>
          <PlainButton Icon={CloseIcon} $tooltip="Remove expression" $onClick={() => onChange({ ...value, matchExpressions: value.matchExpressions.filter((_, at) => at !== index) })}>
            <Span $visuallyHidden>Remove expression {index + 1}</Span>
          </PlainButton>
        </Div>
      );
    })}
    <Div>
      <PlainButton Icon={AddIcon} $onClick={() => onChange({ ...value, matchExpressions: [...value.matchExpressions, { key: "", operator: "In", values: [] }] })}>
        Add expression
      </PlainButton>
    </Div>
  </Div>
);
