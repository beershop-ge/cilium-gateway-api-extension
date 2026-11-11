import { Div, Span } from "@k8slens/element-components";
import { TextInput } from "@k8slens/input-components";
import { observer } from "mobx-react";
import { kubernetesNameError } from "../common/format";
import type { Json, Path } from "../common/json";
import { NamespaceSelect } from "../resources/namespace-select";
import { FieldLabel, Section, Select } from "../ui/components";
import type { BuilderProps, DesignerContext } from "./data";
import { AddButton, InlineIssues, NumberField, RemoveButton, Row, SubCard, TextField, gatewayStyles } from "./fields";
import { appendAt, editField, parentRefFor, removeAt, servicePortsOf } from "./manifest";
import { describeParentRef } from "./status";
import { issuesUnder, listenerAdmits, namespaceLabelsOf } from "./validation";

export const MetadataFields = observer(({ ctx, document, onChange, isNew, namespaced = true }: BuilderProps & { namespaced?: boolean }) => {
  const name: string = document?.metadata?.name ?? "";
  const nameError = isNew && name ? kubernetesNameError(name) : undefined;

  return (
    <Row>
      <div className={gatewayStyles.grow}>
        <FieldLabel label="Name" required error={nameError ?? (isNew && !name ? "A name is required" : undefined)} help={isNew ? undefined : "The name of an existing resource cannot change"}>
          <TextInput aria-label="Name" value={name} readOnly={!isNew} onChange={(event) => onChange(editField(document, ["metadata", "name"], event.target.value.trim()))} />
        </FieldLabel>
      </div>
      {namespaced && (
        <div className={gatewayStyles.grow}>
          <FieldLabel label="Namespace" required error={issuesUnder(ctx.issues, ["metadata", "namespace"]).find((issue) => issue.severity === "error")?.message}>
            {isNew ? (
              <NamespaceSelect clusterId={ctx.clusterId} value={document?.metadata?.namespace} onChange={(namespace) => onChange(editField(document, ["metadata", "namespace"], namespace))} />
            ) : (
              <TextInput aria-label="Namespace" value={document?.metadata?.namespace ?? ""} readOnly />
            )}
          </FieldLabel>
        </div>
      )}
    </Row>
  );
});

const serviceKey = (namespace: string | undefined, name: string | undefined) => `${namespace ?? ""}/${name ?? ""}`;

/**
 * Picks a Service and one of its ports for a backendRef, and a weight when traffic is split. The
 * Services of the route's namespace come first; others need a ReferenceGrant, which the checks offer.
 */
export const BackendRefFields = observer(
  ({ ctx, routeNamespace, backend, path, onChange, showWeight, portRequired = true }: { ctx: DesignerContext; routeNamespace: string | undefined; backend: Json; path: Path; onChange: (backend: Json) => void; showWeight: boolean; portRequired?: boolean }) => {
    const services = ctx.inventory.services;
    const kind = backend?.kind ?? "Service";
    const namespace = backend?.namespace ?? routeNamespace;
    const service = services?.find((candidate) => candidate.metadata?.name === backend?.name && candidate.metadata?.namespace === namespace);
    const ports = servicePortsOf(service);
    const set = (field: string, value: Json) => onChange(editField(backend ?? {}, [field], value));

    if (kind !== "Service" || (backend?.group ?? "") !== "") {
      return (
        <Row>
          <Span $color="textMuted" $font={{ size: "s" }}>
            Backend {backend?.group ? `${backend.group}/` : ""}
            {kind} {backend?.name}: edit it in the Advanced YAML view.
          </Span>
        </Row>
      );
    }

    const sorted = [...(services ?? [])].sort(
      (a, b) => Number(b.metadata.namespace === routeNamespace) - Number(a.metadata.namespace === routeNamespace) || serviceKey(a.metadata.namespace, a.metadata.name).localeCompare(serviceKey(b.metadata.namespace, b.metadata.name)),
    );

    return (
      <Div $flex={{ direction: "vertical", gap: "xxs" }}>
        <Row>
          {services ? (
            <div className={gatewayStyles.grow}>
              <FieldLabel label="Service" required>
                <Select
                  ariaLabel="Service"
                  value={backend?.name ? serviceKey(namespace, backend.name) : undefined}
                  placeholder={backend?.name ? `${serviceKey(namespace, backend.name)} (not found)` : "Select a Service"}
                  options={sorted.map((candidate) => ({
                    value: serviceKey(candidate.metadata.namespace, candidate.metadata.name),
                    label: candidate.metadata.namespace === routeNamespace ? candidate.metadata.name : `${candidate.metadata.namespace}/${candidate.metadata.name} (other namespace)`,
                  }))}
                  onChange={(value) => {
                    const [serviceNamespace, name] = value.split("/");
                    const chosen = services.find((candidate) => candidate.metadata.namespace === serviceNamespace && candidate.metadata.name === name);
                    const chosenPorts = servicePortsOf(chosen);
                    const next: Json = { ...(backend ?? {}), name };

                    if (serviceNamespace !== routeNamespace) next.namespace = serviceNamespace;
                    else delete next.namespace;

                    // Keep the port when the new Service has it too; otherwise take its only port.
                    if (!chosenPorts.some((port) => port.port === next.port)) {
                      if (chosenPorts.length === 1) next.port = chosenPorts[0].port;
                      else delete next.port;
                    }

                    onChange(next);
                  }}
                />
              </FieldLabel>
            </div>
          ) : (
            <>
              <TextField label="Service" required value={backend?.name} onChange={(value) => set("name", value.trim())} help="Services could not be listed; type the name" />
              <TextField label="Namespace" value={backend?.namespace} placeholder={routeNamespace} onChange={(value) => set("namespace", value.trim() === routeNamespace ? "" : value.trim())} />
            </>
          )}
          {service && ports.length > 0 ? (
            <div className={gatewayStyles.medium}>
              <FieldLabel label="Port" required={portRequired}>
                <Select
                  ariaLabel="Port"
                  value={backend?.port === undefined ? undefined : String(backend.port)}
                  placeholder={backend?.port !== undefined ? `${backend.port} (not a port of the Service)` : "Select a port"}
                  options={ports.map((port) => ({ value: String(port.port), label: `${port.port}${port.name ? ` (${port.name})` : ""} ${port.protocol}${port.appProtocol ? ` · ${port.appProtocol}` : ""}` }))}
                  onChange={(value) => set("port", Number(value))}
                />
              </FieldLabel>
            </div>
          ) : (
            <NumberField label="Port" required={portRequired} value={backend?.port} min={1} max={65535} onChange={(value) => set("port", value)} />
          )}
          {showWeight && <NumberField label="Weight" value={backend?.weight} min={0} max={1000000} placeholder="1" help="Relative share" onChange={(value) => set("weight", value)} />}
        </Row>
        <InlineIssues issues={issuesUnder(ctx.issues, path).filter((issue) => !issue.grant)} />
      </Div>
    );
  },
);

/** The listeners of the Gateways a route may attach to, labelled with whether each admits the route. */
const gatewayOptions = (ctx: DesignerContext, route: Json) => {
  const namespace = route?.metadata?.namespace;
  const labels = namespace ? namespaceLabelsOf(ctx.inventory, namespace) : undefined;

  return (ctx.inventory.gateways ?? []).map((gateway) => {
    const listeners = (gateway.spec?.listeners ?? []) as Json[];
    const admitting = listeners.filter((listener) => namespace && listenerAdmits(listener, gateway.metadata.namespace, { kind: route.kind, namespace }, labels).admitted);

    return {
      gateway,
      value: `${gateway.metadata.namespace}/${gateway.metadata.name}`,
      label: `${gateway.metadata.namespace === namespace ? "" : `${gateway.metadata.namespace}/`}${gateway.metadata.name}${admitting.length === 0 ? " (admits no route like this)" : ""}`,
    };
  });
};

/** Edits a route's parentRefs: which Gateways, and which listener (by name or port) of each, it attaches to. */
export const ParentRefsEditor = observer(({ ctx, document, onChange, portAvailable }: BuilderProps & { portAvailable: boolean }) => {
  const namespace = document?.metadata?.namespace;
  const refs = (document?.spec?.parentRefs ?? []) as Json[];
  const options = gatewayOptions(ctx, document);
  const path: Path = ["spec", "parentRefs"];

  return (
    <Section title="Attached to (parentRefs)">
      {refs.length === 0 && (
        <Span $color="textMuted" $font={{ size: "s" }}>
          Not attached to any Gateway yet.
        </Span>
      )}
      {refs.map((ref, index) => {
        const isGateway = (ref.kind ?? "Gateway") === "Gateway";
        const gatewayNamespace = ref.namespace ?? namespace;
        const gateway = ctx.inventory.gateways?.find((candidate) => candidate.metadata.name === ref.name && candidate.metadata.namespace === gatewayNamespace);
        const listeners = (gateway?.spec?.listeners ?? []) as Json[];
        const labels = namespace ? namespaceLabelsOf(ctx.inventory, namespace) : undefined;
        const setRef = (next: Json) => onChange(editField(document, [...path, index], next));

        return (
          <SubCard key={index} title={describeParentRef(ref, namespace)} actions={<RemoveButton label="Detach from this parent" onClick={() => onChange(removeAt(document, path, index))} />}>
            {isGateway ? (
              <Row>
                <div className={gatewayStyles.grow}>
                  <FieldLabel label="Gateway" required>
                    {ctx.inventory.gateways ? (
                      <Select
                        ariaLabel="Gateway"
                        value={ref.name ? `${gatewayNamespace}/${ref.name}` : undefined}
                        placeholder={ref.name ? `${gatewayNamespace}/${ref.name} (not found)` : "Select a Gateway"}
                        options={options.map((option) => ({ value: option.value, label: option.label }))}
                        onChange={(value) => {
                          const [targetNamespace, name] = value.split("/");

                          setRef(parentRefFor(namespace, { name, namespace: targetNamespace }));
                        }}
                      />
                    ) : (
                      <TextInput aria-label="Gateway" value={ref.name ?? ""} onChange={(event) => setRef({ ...ref, name: event.target.value.trim() })} />
                    )}
                  </FieldLabel>
                </div>
                <div className={gatewayStyles.medium}>
                  <FieldLabel label="Listener (sectionName)">
                    <Select
                      ariaLabel="Listener"
                      value={ref.sectionName ?? ""}
                      options={[
                        { value: "", label: "Every listener that admits it" },
                        ...listeners.map((listener) => {
                          const admission = namespace ? listenerAdmits(listener, gatewayNamespace, { kind: document.kind, namespace }, labels) : { admitted: true };

                          return { value: String(listener.name), label: `${listener.name} · ${listener.protocol} :${listener.port}${listener.hostname ? ` · ${listener.hostname}` : ""}${admission.admitted ? "" : " (does not admit)"}` };
                        }),
                        ...(ref.sectionName && !listeners.some((listener) => listener.name === ref.sectionName) ? [{ value: ref.sectionName, label: `${ref.sectionName} (not found)` }] : []),
                      ]}
                      onChange={(value) => setRef(editField(ref, ["sectionName"], value))}
                    />
                  </FieldLabel>
                </div>
                {portAvailable && <NumberField label="Port" value={ref.port} min={1} max={65535} help="Optional" onChange={(value) => setRef(editField(ref, ["port"], value))} />}
              </Row>
            ) : (
              <Span $color="textMuted" $font={{ size: "s" }}>
                A {ref.kind} parent: edit it in the Advanced YAML view.
              </Span>
            )}
            <InlineIssues issues={issuesUnder(ctx.issues, [...path, index])} />
          </SubCard>
        );
      })}
      <Div>
        <AddButton onClick={() => onChange(appendAt(document, path, { group: "gateway.networking.k8s.io", kind: "Gateway", name: "" }))}>Attach to a Gateway</AddButton>
      </Div>
    </Section>
  );
});
