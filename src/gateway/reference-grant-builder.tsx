import { Div, Span } from "@k8slens/element-components";
import { TextInput } from "@k8slens/input-components";
import { observer } from "mobx-react";
import type { Json, Path } from "../common/json";
import { NamespaceSelect } from "../resources/namespace-select";
import { FieldLabel, Section, Select } from "../ui/components";
import type { BuilderProps } from "./data";
import { MetadataFields } from "./common-builders";
import { AddButton, InlineIssues, RemoveButton, Row, SubCard, gatewayStyles } from "./fields";
import { gatewayGroup, routeKinds } from "./features";
import { appendAt, editField, removeAt } from "./manifest";
import { issuesUnder } from "./validation";

/** Targets a ReferenceGrant can open up, by the group they live in. */
const targetKinds: ReadonlyArray<{ group: string; kind: string; label: string }> = [
  { group: "", kind: "Service", label: "Service" },
  { group: "", kind: "Secret", label: "Secret (certificates)" },
  { group: gatewayGroup, kind: "Gateway", label: "Gateway" },
];

export const ReferenceGrantBuilder = observer(({ ctx, document, onChange, isNew }: BuilderProps) => {
  const from = (document?.spec?.from ?? []) as Json[];
  const to = (document?.spec?.to ?? []) as Json[];
  const namespace = document?.metadata?.namespace;
  const sourceKinds = ["Gateway", ...routeKinds.filter((kind) => ctx.features.installed[kind])];
  const fromPath: Path = ["spec", "from"];
  const toPath: Path = ["spec", "to"];
  const namesOf = (kind: string) =>
    kind === "Service"
      ? (ctx.inventory.services ?? []).filter((service) => service.metadata.namespace === namespace).map((service) => String(service.metadata.name))
      : kind === "Secret"
        ? (ctx.inventory.secrets ?? []).filter((secret) => secret.metadata.namespace === namespace).map((secret) => String(secret.metadata.name))
        : kind === "Gateway"
          ? (ctx.inventory.gateways ?? []).filter((gateway) => gateway.metadata.namespace === namespace).map((gateway) => String(gateway.metadata.name))
          : [];

  return (
    <Div $flex={{ direction: "vertical", gap: "l" }}>
      <MetadataFields ctx={ctx} document={document} onChange={onChange} isNew={isNew} />
      <Span $color="textMuted" $font={{ size: "s" }}>
        A ReferenceGrant lives in the namespace of what is referred to ({namespace ?? "choose a namespace"}), and lets resources of the listed kinds in the listed namespaces refer to it.
      </Span>

      <Section title="From (who may refer)">
        {from.map((entry, index) => (
          <SubCard key={index} actions={<RemoveButton label="Remove source" onClick={() => onChange(removeAt(document, fromPath, index))} />}>
            <Row>
              <div className={gatewayStyles.medium}>
                <FieldLabel label="Kind" required>
                  <Select
                    ariaLabel="Source kind"
                    value={entry.kind}
                    options={sourceKinds.map((kind) => ({ value: kind, label: kind }))}
                    onChange={(kind) => onChange(editField(document, [...fromPath, index], { ...entry, group: gatewayGroup, kind }))}
                  />
                </FieldLabel>
              </div>
              <div className={gatewayStyles.grow}>
                <FieldLabel label="Namespace" required>
                  <NamespaceSelect clusterId={ctx.clusterId} value={entry.namespace} onChange={(value) => onChange(editField(document, [...fromPath, index, "namespace"], value))} />
                </FieldLabel>
              </div>
            </Row>
            <InlineIssues issues={issuesUnder(ctx.issues, [...fromPath, index])} />
          </SubCard>
        ))}
        <Div>
          <AddButton onClick={() => onChange(appendAt(document, fromPath, { group: gatewayGroup, kind: "HTTPRoute", namespace: "" }))}>Source</AddButton>
        </Div>
        <InlineIssues issues={issuesUnder(ctx.issues, fromPath, { exact: true })} />
      </Section>

      <Section title={`To (what in ${namespace ?? "this namespace"} may be referred to)`}>
        {to.map((entry, index) => {
          const names = namesOf(entry.kind);

          return (
            <SubCard key={index} actions={<RemoveButton label="Remove target" onClick={() => onChange(removeAt(document, toPath, index))} />}>
              <Row>
                <div className={gatewayStyles.medium}>
                  <FieldLabel label="Kind" required>
                    <Select
                      ariaLabel="Target kind"
                      value={targetKinds.find((target) => target.kind === entry.kind && target.group === (entry.group ?? ""))?.kind}
                      placeholder={entry.kind ? `${entry.group ? `${entry.group}/` : ""}${entry.kind}` : "Select a kind"}
                      options={targetKinds.map((target) => ({ value: target.kind, label: target.label }))}
                      onChange={(kind) => {
                        const target = targetKinds.find((candidate) => candidate.kind === kind)!;

                        onChange(editField(document, [...toPath, index], { group: target.group, kind: target.kind }));
                      }}
                    />
                  </FieldLabel>
                </div>
                <div className={gatewayStyles.grow}>
                  <FieldLabel label="Name" help="Leave empty to allow every resource of the kind in the namespace">
                    {names.length > 0 ? (
                      <Select
                        ariaLabel="Target name"
                        value={entry.name ?? ""}
                        options={[{ value: "", label: "Any" }, ...names.map((name) => ({ value: name, label: name })), ...(entry.name && !names.includes(entry.name) ? [{ value: entry.name, label: `${entry.name} (not found)` }] : [])]}
                        onChange={(value) => onChange(editField(document, [...toPath, index, "name"], value))}
                      />
                    ) : (
                      <TextInput aria-label="Target name" placeholder="any" value={entry.name ?? ""} onChange={(event) => onChange(editField(document, [...toPath, index, "name"], event.target.value.trim()))} />
                    )}
                  </FieldLabel>
                </div>
              </Row>
              <InlineIssues issues={issuesUnder(ctx.issues, [...toPath, index])} />
            </SubCard>
          );
        })}
        <Div>
          <AddButton onClick={() => onChange(appendAt(document, toPath, { group: "", kind: "Service" }))}>Target</AddButton>
        </Div>
        <InlineIssues issues={issuesUnder(ctx.issues, toPath, { exact: true })} />
      </Section>
    </Div>
  );
});
