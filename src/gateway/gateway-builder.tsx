import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { EditIcon, LinkIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { observer } from "mobx-react";
import { Fragment, useState } from "react";
import type { Json, Path } from "../common/json";
import { cleanForEdit } from "../common/manifest";
import { itemsOf } from "../kube/snapshot";
import { Callout, Checkbox, FieldLabel, Section, Select } from "../ui/components";
import { KeyValueEditor, labelKeyError } from "../ui/key-value-editor";
import { allRoutesOf, type BuilderProps, type DesignerContext } from "./data";
import { MetadataFields } from "./common-builders";
import { AddButton, InlineIssues, RemoveButton, Row, TextField, gatewayStyles } from "./fields";
import { isRouteKind } from "./features";
import { appendAt, attachRoute, changeListenerProtocol, detachRouteFromListener, editField, newListener, removeAt } from "./manifest";
import { routesOfListener } from "./status";
import { defaultRouteKinds, issuesUnder, listenerAdmits, namespaceLabelsOf } from "./validation";

const ListenerDetails = observer(({ ctx, gateway, listener, path, onChange }: { ctx: DesignerContext; gateway: Json; listener: Json; path: Path; onChange: (listener: Json) => void }) => {
  const namespace = gateway?.metadata?.namespace;
  const protocol = listener?.protocol;
  const tls = listener?.tls;
  const set = (field: Path, value: Json) => onChange(editField(listener, field, value));
  const secrets = (ctx.inventory.secrets ?? []).filter((secret) => secret.type === "kubernetes.io/tls" || secret.type === undefined);
  const refs = (tls?.certificateRefs ?? []) as Json[];
  const from = listener?.allowedRoutes?.namespaces?.from ?? "Same";
  const kinds = (listener?.allowedRoutes?.kinds ?? []) as Json[];
  const compatible = defaultRouteKinds({ ...listener, allowedRoutes: undefined }).filter((kind) => isRouteKind(kind) && ctx.features.installed[kind]);
  const refKey = (ref: Json) => `${ref.namespace ?? namespace}/${ref.name}`;

  return (
    <Div $flex={{ direction: "vertical", gap: "s" }} $padding={{ vertical: "xs" }}>
      {(protocol === "HTTPS" || protocol === "TLS") && (
        <Row>
          <div className={gatewayStyles.medium}>
            <FieldLabel label="TLS mode">
              <Select
                ariaLabel="TLS mode"
                value={tls?.mode ?? "Terminate"}
                options={ctx.features.gateway.tlsModes.map((mode) => ({ value: mode, label: mode, disabled: protocol === "HTTPS" && mode !== "Terminate" }))}
                onChange={(mode) => set(["tls"], mode === "Passthrough" ? { ...(tls ?? {}), mode, certificateRefs: undefined } : { ...(tls ?? {}), mode, certificateRefs: tls?.certificateRefs ?? [] })}
              />
            </FieldLabel>
          </div>
          {(tls?.mode ?? "Terminate") === "Terminate" && (
            <div className={gatewayStyles.grow}>
              <FieldLabel
                label="Certificates (TLS Secrets)"
                required
                help={ctx.inventory.secrets ? "Secrets of type kubernetes.io/tls; one in another namespace needs a ReferenceGrant" : "Secrets could not be listed; type a name"}
              >
                <Div $flex={{ direction: "vertical", gap: "xs" }}>
                  {refs.map((ref, index) => (
                    <Div key={index} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
                      <LinkIcon $size="s" />
                      <Span $flexChild>{ref.namespace && ref.namespace !== namespace ? `${ref.namespace}/${ref.name}` : ref.name}</Span>
                      <RemoveButton label={`Remove certificate ${ref.name}`} onClick={() => set(["tls", "certificateRefs"], refs.filter((_, position) => position !== index))} />
                    </Div>
                  ))}
                  {ctx.inventory.secrets ? (
                    <Select
                      ariaLabel="Add a certificate"
                      value={undefined}
                      placeholder={secrets.length ? "Add a certificate…" : "No TLS Secrets found"}
                      options={[...secrets]
                        .sort((a, b) => Number(b.metadata.namespace === namespace) - Number(a.metadata.namespace === namespace) || `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`))
                        .filter((secret) => !refs.some((ref) => refKey(ref) === `${secret.metadata.namespace}/${secret.metadata.name}`))
                        .map((secret) => ({
                          value: `${secret.metadata.namespace}/${secret.metadata.name}`,
                          label: secret.metadata.namespace === namespace ? secret.metadata.name : `${secret.metadata.namespace}/${secret.metadata.name} (other namespace)`,
                        }))}
                      onChange={(value) => {
                        const [secretNamespace, name] = value.split("/");

                        set(["tls", "certificateRefs"], [...refs, { group: "", kind: "Secret", name, ...(secretNamespace !== namespace ? { namespace: secretNamespace } : {}) }]);
                      }}
                    />
                  ) : (
                    <CertificateNameInput onAdd={(name) => set(["tls", "certificateRefs"], [...refs, { group: "", kind: "Secret", name }])} />
                  )}
                </Div>
              </FieldLabel>
            </div>
          )}
        </Row>
      )}

      <Row>
        <div className={gatewayStyles.medium}>
          <FieldLabel label="Routes from namespaces">
            <Select
              ariaLabel="Routes from namespaces"
              value={from}
              options={ctx.features.gateway.allowedRoutesFrom.map((value) => ({ value, label: value === "Same" ? `Same (${namespace ?? "the Gateway's"})` : value }))}
              onChange={(value) =>
                set(["allowedRoutes", "namespaces"], value === "Selector" ? { from: value, selector: listener?.allowedRoutes?.namespaces?.selector ?? { matchLabels: {} } } : { from: value })
              }
            />
          </FieldLabel>
        </div>
        {from === "Selector" && (
          <div className={gatewayStyles.grow}>
            <FieldLabel label="Namespace labels (matchLabels)" help="kubernetes.io/metadata.name=<namespace> selects one namespace by name">
              <KeyValueEditor
                ariaLabel="namespace selector"
                value={listener?.allowedRoutes?.namespaces?.selector?.matchLabels}
                validateKey={labelKeyError}
                onChange={(labels) => set(["allowedRoutes", "namespaces", "selector", "matchLabels"], labels ?? {})}
              />
            </FieldLabel>
          </div>
        )}
        <div className={gatewayStyles.grow}>
          <FieldLabel label="Route kinds" help={kinds.length === 0 ? `Default for ${protocol}: ${defaultRouteKinds({ ...listener, allowedRoutes: undefined }).join(", ") || "none"}` : undefined}>
            <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
              {compatible.map((kind) => (
                <Checkbox
                  key={kind}
                  label={kind}
                  checked={kinds.some((candidate) => candidate.kind === kind)}
                  onChange={(checked) =>
                    set(
                      ["allowedRoutes", "kinds"],
                      checked ? [...kinds, { group: "gateway.networking.k8s.io", kind }] : kinds.filter((candidate) => candidate.kind !== kind),
                    )
                  }
                />
              ))}
              {compatible.length === 0 && <Span $color="textMuted">No installed route kind fits {protocol}</Span>}
            </Div>
          </FieldLabel>
        </div>
      </Row>
      <InlineIssues issues={issuesUnder(ctx.issues, path).filter((issue) => !issue.grant)} />
    </Div>
  );
});

const CertificateNameInput = ({ onAdd }: { onAdd: (name: string) => void }) => {
  const [name, setName] = useState("");

  return (
    <Div $flex={{ direction: "horizontal", gap: "xs" }}>
      <Div $flexChild>
        <TextInput aria-label="Secret name" placeholder="secret name" value={name} onChange={(event) => setName(event.target.value.trim())} />
      </Div>
      <AddButton
        enabled={name !== ""}
        onClick={() => {
          onAdd(name);
          setName("");
        }}
      >
        Add
      </AddButton>
    </Div>
  );
};

const ListenersTable = observer(({ ctx, document, onChange }: Omit<BuilderProps, "isNew">) => {
  const listeners = (document?.spec?.listeners ?? []) as Json[];
  const [expanded, setExpanded] = useState<number | undefined>(0);
  const path: Path = ["spec", "listeners"];
  const setListener = (index: number, listener: Json) => onChange(editField(document, [...path, index], listener));
  const errorAt = (index: number, field: string) => issuesUnder(ctx.issues, [...path, index, field]).some((issue) => issue.severity === "error");

  return (
    <Section title={`Listeners (${listeners.length})`}>
      <table className={gatewayStyles.listenerTable}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Protocol</th>
            <th>Port</th>
            <th>Hostname</th>
            <th>TLS / routes</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {listeners.map((listener, index) => (
            <Fragment key={index}>
              <tr className={expanded === index ? gatewayStyles.expanded : undefined}>
                <td>
                  <TextInput aria-label={`Listener ${index + 1} name`} aria-invalid={errorAt(index, "name")} value={listener.name ?? ""} onChange={(event) => setListener(index, { ...listener, name: event.target.value.trim() })} />
                </td>
                <td style={{ width: 110 }}>
                  <Select
                    ariaLabel={`Listener ${index + 1} protocol`}
                    value={listener.protocol}
                    options={[...new Set([...ctx.features.gateway.protocols, ...(listener.protocol ? [listener.protocol] : [])])].map((protocol) => ({ value: protocol, label: protocol }))}
                    onChange={(protocol) => setListener(index, changeListenerProtocol(listener, protocol))}
                  />
                </td>
                <td style={{ width: 100 }}>
                  <TextInput
                    type="number"
                    aria-label={`Listener ${index + 1} port`}
                    aria-invalid={errorAt(index, "port")}
                    min={1}
                    max={65535}
                    value={listener.port === undefined ? "" : String(listener.port)}
                    onChange={(event) => setListener(index, editField(listener, ["port"], event.target.value === "" ? undefined : Number(event.target.value)))}
                  />
                </td>
                <td>
                  <TextInput
                    aria-label={`Listener ${index + 1} hostname`}
                    aria-invalid={errorAt(index, "hostname")}
                    placeholder={listener.protocol === "TCP" || listener.protocol === "UDP" ? "not applicable" : "any (or *.example.com)"}
                    readOnly={listener.protocol === "TCP" || listener.protocol === "UDP"}
                    value={listener.hostname ?? ""}
                    onChange={(event) => setListener(index, editField(listener, ["hostname"], event.target.value.trim().toLowerCase()))}
                  />
                </td>
                <td>
                  <Div $flex={{ direction: "horizontal", gap: "xxs", wrap: true, verticalAlign: "center" }}>
                    {listener.tls && <Badge small label={`${listener.tls.mode ?? "Terminate"}${listener.tls.certificateRefs?.length ? ` · ${listener.tls.certificateRefs.length} cert` : ""}`} />}
                    <Badge small label={`from ${listener.allowedRoutes?.namespaces?.from ?? "Same"}`} />
                    {issuesUnder(ctx.issues, [...path, index]).some((issue) => issue.severity === "error") && <Badge small label="issues" $backgroundColor="critical" $color="white" />}
                    <PlainButton Icon={EditIcon} $onClick={() => setExpanded(expanded === index ? undefined : index)}>
                      {expanded === index ? "Less" : "More"}
                    </PlainButton>
                  </Div>
                </td>
                <td style={{ width: 40 }}>
                  <RemoveButton label={`Remove listener ${listener.name}`} onClick={() => onChange(removeAt(document, path, index))} />
                </td>
              </tr>
              {expanded === index && (
                <tr className={gatewayStyles.expanded}>
                  <td colSpan={6}>
                    <ListenerDetails ctx={ctx} gateway={document} listener={listener} path={[...path, index]} onChange={(next) => setListener(index, next)} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
        {ctx.features.gateway.protocols.map((protocol) => (
          <AddButton
            key={protocol}
            onClick={() => {
              onChange(appendAt(document, path, newListener(listeners, { protocol })));
              setExpanded(listeners.length);
            }}
          >
            {protocol} listener
          </AddButton>
        ))}
      </Div>
      <InlineIssues issues={issuesUnder(ctx.issues, path, { exact: true })} />
    </Section>
  );
});

const AddressesEditor = observer(({ ctx, document, onChange }: Omit<BuilderProps, "isNew">) => {
  const availability = ctx.features.gateway.addresses;
  const addresses = (document?.spec?.addresses ?? []) as Json[];
  const path: Path = ["spec", "addresses"];

  if (!availability.available) {
    return addresses.length > 0 ? <Callout level="warning">This Gateway requests addresses, which {availability.reason?.toLowerCase()}. Edit them in the Advanced YAML view.</Callout> : null;
  }

  return (
    <Section title="Requested addresses (optional)">
      <Span $color="textMuted" $font={{ size: "s" }}>
        Leave empty to let Cilium's LB-IPAM assign one from a CiliumLoadBalancerIPPool.
      </Span>
      {addresses.map((address, index) => (
        <Row key={index}>
          <div className={gatewayStyles.medium}>
            <Select
              ariaLabel="Address type"
              value={address.type ?? "IPAddress"}
              options={ctx.features.gateway.addressTypes.map((type) => ({ value: type, label: type }))}
              onChange={(type) => onChange(editField(document, [...path, index, "type"], type))}
            />
          </div>
          <TextField label="Value" value={address.value} onChange={(value) => onChange(editField(document, [...path, index, "value"], value.trim()))} issues={ctx.issues} path={[...path, index, "value"]} />
          <RemoveButton label="Remove address" onClick={() => onChange(removeAt(document, path, index))} />
        </Row>
      ))}
      <Div>
        <AddButton onClick={() => onChange(appendAt(document, path, { type: "IPAddress", value: "" }))}>Request an address</AddButton>
      </Div>
    </Section>
  );
});

/** The routes attached to each listener, with attach and detach: both open the route with its parentRefs changed, for review. */
const AttachedRoutes = observer(({ ctx, document }: { ctx: DesignerContext; document: Json }) => {
  const routes = allRoutesOf(ctx.snapshot);
  const listeners = (document?.spec?.listeners ?? []) as Json[];
  const namespace = document?.metadata?.namespace;
  const name = document?.metadata?.name;
  const [choice, setChoice] = useState<Record<string, string>>({});

  if (!name || !namespace) {
    return null;
  }

  const routeKey = (route: Json) => `${route.kind}|${route.metadata.namespace}/${route.metadata.name}`;

  return (
    <Section title="Attached routes">
      <Span $color="textMuted" $font={{ size: "s" }}>
        Attaching or detaching changes the route's parentRefs; the route opens in its builder so you can review and apply the change.
      </Span>
      {listeners.map((listener, index) => {
        const attached = routesOfListener(routes, document, listener);
        const candidates = routes.filter((route) => {
          const labels = namespaceLabelsOf(ctx.inventory, route.metadata.namespace);

          return !attached.includes(route) && listenerAdmits(listener, namespace, { kind: route.kind, namespace: route.metadata.namespace }, labels).admitted;
        });
        const selected = choice[listener.name];

        return (
          <Div key={`${listener.name}-${index}`} $flex={{ direction: "vertical", gap: "xs" }}>
            <Span $font={{ bold: true }}>
              {listener.name} · {listener.protocol} :{listener.port}
              {listener.hostname ? ` · ${listener.hostname}` : ""}
            </Span>
            {attached.length === 0 && (
              <Span $color="textMuted" $font={{ size: "s" }}>
                No route attached.
              </Span>
            )}
            {attached.map((route) => (
              <Div key={routeKey(route)} $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
                <Badge small label={route.kind} />
                <Span $flexChild>
                  {route.metadata.namespace}/{route.metadata.name}
                </Span>
                <PlainButton $onClick={() => ctx.edit(route.kind, cleanForEdit(route), route)}>Open</PlainButton>
                <PlainButton $onClick={() => ctx.edit(route.kind, detachRouteFromListener(cleanForEdit(route), document, listener), route)}>Detach</PlainButton>
              </Div>
            ))}
            {candidates.length > 0 && (
              <Row>
                <div className={gatewayStyles.grow}>
                  <Select
                    ariaLabel={`Route to attach to ${listener.name}`}
                    value={selected}
                    placeholder="Attach a route that this listener admits…"
                    options={candidates.map((route) => ({ value: routeKey(route), label: `${route.kind} ${route.metadata.namespace}/${route.metadata.name}` }))}
                    onChange={(value) => setChoice({ ...choice, [listener.name]: value })}
                  />
                </div>
                <PlainButton
                  Icon={LinkIcon}
                  $enabled={Boolean(selected)}
                  $onClick={() => {
                    const route = candidates.find((candidate) => routeKey(candidate) === selected);

                    if (route) ctx.edit(route.kind, attachRoute(cleanForEdit(route), { name, namespace, sectionName: listener.name }), route);
                  }}
                >
                  Attach
                </PlainButton>
              </Row>
            )}
          </Div>
        );
      })}
    </Section>
  );
});

export const GatewayBuilder = observer(({ ctx, document, onChange, isNew }: BuilderProps) => {
  const classes = itemsOf(ctx.snapshot, "GatewayClass");
  const className: string | undefined = document?.spec?.gatewayClassName;

  return (
    <Div $flex={{ direction: "vertical", gap: "l" }}>
      <MetadataFields ctx={ctx} document={document} onChange={onChange} isNew={isNew} />

      <Row>
        <div className={gatewayStyles.grow}>
          <FieldLabel
            label="GatewayClass"
            required
            error={issuesUnder(ctx.issues, ["spec", "gatewayClassName"]).find((issue) => issue.severity === "error")?.message}
            help={classes.length === 0 ? "No GatewayClass exists yet: create one in the GatewayClass tab first." : undefined}
          >
            <Select
              ariaLabel="GatewayClass"
              value={className}
              placeholder={className ? `${className} (not found)` : "Select a GatewayClass"}
              options={classes.map((item) => ({ value: item.metadata.name, label: `${item.metadata.name} · ${item.spec?.controllerName ?? ""}` }))}
              onChange={(value) => onChange(editField(document, ["spec", "gatewayClassName"], value))}
            />
          </FieldLabel>
        </div>
      </Row>

      <ListenersTable ctx={ctx} document={document} onChange={onChange} />
      <AddressesEditor ctx={ctx} document={document} onChange={onChange} />
      {!isNew && <AttachedRoutes ctx={ctx} document={document} />}
    </Div>
  );
});
