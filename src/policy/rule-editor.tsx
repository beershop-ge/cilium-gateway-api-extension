import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { AddIcon, KeyboardArrowDownIcon, KeyboardArrowUpIcon, CloseIcon, DeleteIcon, OpenWithIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { type DragEvent, useState } from "react";
import { Checkbox, FieldLabel, Select, uiStyles } from "../ui/components";
import { NamespaceSelect } from "../resources/namespace-select";
import {
  addPeerToRule,
  addRuleWithPeer,
  ciliumEntities,
  type Direction,
  directionLabel,
  emptySelector,
  isDeny,
  l3GroupOf,
  moveRule,
  newId,
  newPeer,
  newPort,
  newPortRule,
  type Peer,
  type PeerType,
  peerTypeLabel,
  peerTypesFor,
  type PolicyModel,
  type PortRuleModel,
  type Protocol,
  protocols,
  removePeer,
  removeRule,
  type RuleModel,
  supportsL7,
  updatePeer,
  updateRule,
  updateSection,
} from "./model";
import { ListInput, SelectorEditor } from "./selector-editor";
import { summarizeRule } from "./summary";
import styles from "./policy.module.scss";

// Drag data is typed by MIME type, which a drop target can read while dragging over (the data itself it cannot).
const peerMime = (type: PeerType) => `application/x-cilium-peer-${type.toLowerCase()}`;
const ruleMime = (direction: Direction) => `application/x-cilium-rule-${direction.toLowerCase()}`;
const peerTypeOfDrag = (event: DragEvent) => {
  const mime = [...event.dataTransfer.types].find((type) => type.startsWith("application/x-cilium-peer-"));

  return mime ? (["endpoint", "namespace", "entity", "cidr", "cidrgroup", "fqdn", "service"] as const).find((type) => mime === `application/x-cilium-peer-${type}`) : undefined;
};
const normalizePeerType = (type: string): PeerType => (type === "cidrgroup" ? "cidrGroup" : (type as PeerType));

export interface BuilderEnv {
  readonly clusterId: string;
  readonly cidrGroups: readonly string[] | undefined;
  readonly cidrGroupsInstalled: boolean;
}

/** One palette entry: drag it onto a lane to add a rule. The lanes' own "Add rule" controls do the same by keyboard. */
export const PaletteChip = ({ type }: { type: Exclude<PeerType, "raw"> }) => (
  <span
    className={`${styles.chip} ${uiStyles.draggable}`}
    draggable
    tabIndex={0}
    role="button"
    aria-roledescription="draggable peer type"
    title={`Drag onto a lane to add a rule allowing or denying ${peerTypeLabel[type]} peers. By keyboard: use "Add rule" in a lane.`}
    onDragStart={(event) => {
      event.dataTransfer.setData(peerMime(type), type);
      event.dataTransfer.setData("text/plain", peerTypeLabel[type]);
      event.dataTransfer.effectAllowed = "copy";
    }}
  >
    <OpenWithIcon $size="xs" />
    {peerTypeLabel[type]}
  </span>
);

const PeerEditor = ({ model, direction, peer, onChange, env }: { model: PolicyModel; direction: Direction; peer: Peer; onChange: (peer: Peer) => void; env: BuilderEnv }) => {
  const cilium = model.kind !== "NetworkPolicy";

  switch (peer.type) {
    case "endpoint":
      return (
        <SelectorEditor
          ariaLabel={cilium ? "Endpoint selector" : "Pod selector"}
          value={peer.selector ?? emptySelector}
          onChange={(selector) => onChange({ ...peer, selector })}
          help={model.kind === "CiliumNetworkPolicy" ? "without a namespace label, endpoints in the policy's namespace; empty: all of them" : model.kind === "NetworkPolicy" ? "pods in the policy's namespace; empty: all of them" : "empty: every endpoint in the cluster"}
        />
      );
    case "namespace":
      return (
        <Div $flex={{ direction: "vertical", gap: "xs" }}>
          <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
            <Div $width={{ width: "9xl" }}>
              <Select
                ariaLabel="Select namespaces by"
                value={peer.namespaceLabels ? "labels" : "name"}
                options={[
                  { value: "name", label: "By name" },
                  { value: "labels", label: "By labels" },
                ]}
                onChange={(mode) => onChange(mode === "labels" ? { ...peer, namespaceName: undefined, namespaceLabels: emptySelector } : { ...peer, namespaceLabels: undefined, namespaceName: "" })}
              />
            </Div>
            {!peer.namespaceLabels && (
              <Div $flexChild>
                <NamespaceSelect clusterId={env.clusterId} ariaLabel="Peer namespace" value={peer.namespaceName || undefined} onChange={(namespaceName) => onChange({ ...peer, namespaceName })} />
              </Div>
            )}
          </Div>
          {peer.namespaceLabels && <SelectorEditor ariaLabel="Namespace labels" value={peer.namespaceLabels} onChange={(namespaceLabels) => onChange({ ...peer, namespaceLabels })} />}
          <Checkbox
            checked={peer.podSelector !== undefined}
            onChange={(checked) => onChange({ ...peer, podSelector: checked ? emptySelector : undefined })}
            label="Only pods matching labels"
          />
          {peer.podSelector && <SelectorEditor ariaLabel="Pods of the namespace" value={peer.podSelector} onChange={(podSelector) => onChange({ ...peer, podSelector })} />}
        </Div>
      );
    case "entity":
      return (
        <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }} role="group" aria-label="Entities">
          {ciliumEntities.map((entity) => (
            <Checkbox
              key={entity}
              label={entity}
              checked={(peer.entities ?? []).includes(entity)}
              onChange={(checked) => onChange({ ...peer, entities: checked ? [...(peer.entities ?? []), entity] : (peer.entities ?? []).filter((other) => other !== entity) })}
            />
          ))}
        </Div>
      );
    case "cidr":
      return (
        <Div $flex={{ direction: "vertical", gap: "xs" }}>
          <Div $flex={{ direction: "horizontal", gap: "s" }}>
            <Div $flexChild>
              <FieldLabel label="CIDR">
                <TextInput aria-label="CIDR" placeholder="10.0.0.0/8" value={peer.cidr ?? ""} onChange={(event) => onChange({ ...peer, cidr: event.target.value.trim() })} />
              </FieldLabel>
            </Div>
            <Div $flexChild>
              <FieldLabel label="Except">
                <ListInput ariaLabel="CIDR exceptions" placeholder="10.1.0.0/16, …" value={peer.except ?? []} onChange={(except) => onChange({ ...peer, except })} />
              </FieldLabel>
            </Div>
          </Div>
          {cilium && <Checkbox checked={Boolean(peer.asSet) || (peer.except ?? []).length > 0} disabled={(peer.except ?? []).length > 0} onChange={(asSet) => onChange({ ...peer, asSet })} label="Write as CIDRSet" />}
        </Div>
      );
    case "cidrGroup":
      return env.cidrGroups && env.cidrGroups.length > 0 ? (
        <Select ariaLabel="CiliumCIDRGroup" value={peer.cidrGroupRef || undefined} placeholder="Select a CIDR group" options={env.cidrGroups.map((name) => ({ value: name, label: name }))} onChange={(cidrGroupRef) => onChange({ ...peer, cidrGroupRef })} />
      ) : (
        <TextInput aria-label="CiliumCIDRGroup name" placeholder="CiliumCIDRGroup name" value={peer.cidrGroupRef ?? ""} onChange={(event) => onChange({ ...peer, cidrGroupRef: event.target.value.trim() })} />
      );
    case "fqdn":
      return (
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
          <Div $width={{ width: "9xl" }}>
            <Select
              ariaLabel="Match FQDN by"
              value={peer.matchPattern !== undefined ? "pattern" : "name"}
              options={[
                { value: "name", label: "matchName" },
                { value: "pattern", label: "matchPattern" },
              ]}
              onChange={(mode) => onChange(mode === "pattern" ? { ...peer, matchName: undefined, matchPattern: peer.matchName ?? "" } : { ...peer, matchPattern: undefined, matchName: peer.matchPattern ?? "" })}
            />
          </Div>
          <Div $flexChild>
            <TextInput
              aria-label="FQDN"
              placeholder={peer.matchPattern !== undefined ? "*.example.com" : "api.example.com"}
              value={peer.matchPattern ?? peer.matchName ?? ""}
              onChange={(event) => onChange(peer.matchPattern !== undefined ? { ...peer, matchPattern: event.target.value.trim() } : { ...peer, matchName: event.target.value.trim() })}
            />
          </Div>
        </Div>
      );
    case "service": {
      const bySelector = peer.selector !== undefined && !peer.serviceName;

      return (
        <Div $flex={{ direction: "vertical", gap: "xs" }}>
          <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
            <Div $width={{ width: "9xl" }}>
              <Select
                ariaLabel="Select Services by"
                value={bySelector ? "selector" : "name"}
                options={[
                  { value: "name", label: "By name" },
                  { value: "selector", label: "By labels" },
                ]}
                onChange={(mode) => onChange(mode === "selector" ? { ...peer, serviceName: "", selector: emptySelector } : { ...peer, selector: undefined })}
              />
            </Div>
            {!bySelector && (
              <Div $flexChild>
                <TextInput aria-label="Service name" placeholder="service name" value={peer.serviceName ?? ""} onChange={(event) => onChange({ ...peer, serviceName: event.target.value.trim() })} />
              </Div>
            )}
            <Div $flexChild>
              <TextInput aria-label="Service namespace" placeholder="namespace (optional)" value={peer.serviceNamespace ?? ""} onChange={(event) => onChange({ ...peer, serviceNamespace: event.target.value.trim() })} />
            </Div>
          </Div>
          {bySelector && <SelectorEditor ariaLabel="Service labels" value={peer.selector ?? emptySelector} onChange={(selector) => onChange({ ...peer, selector })} />}
        </Div>
      );
    }
    case "raw":
      return (
        <Span $font={{ size: "s" }} $color="textMuted">
          <code className={uiStyles.mono}>
            {peer.field}: {JSON.stringify(peer.raw)}
          </code>{" "}
          — the builder does not model this entry and writes it back as it is.
        </Span>
      );
  }
};

const PortRuleEditor = ({ model, direction, portRule, onChange, onRemove }: { model: PolicyModel; direction: Direction; portRule: PortRuleModel; onChange: (value: PortRuleModel) => void; onRemove: () => void }) => {
  const l7 = supportsL7(model.kind, direction);
  const defaultProtocol = model.kind === "NetworkPolicy" ? "TCP" : "ANY";

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }} className={uiStyles.formIndent}>
      {portRule.ports.map((port, index) => {
        const update = (next: Partial<typeof port>) => onChange({ ...portRule, ports: portRule.ports.map((other) => (other.id === port.id ? { ...other, ...next } : other)) });

        return (
          <Div key={port.id} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
            <Div $flexChild>
              <TextInput aria-label={`Port ${index + 1}`} placeholder={model.kind === "NetworkPolicy" ? "port (empty: all)" : "port or name (0: all)"} value={port.port} onChange={(event) => update({ port: event.target.value.trim() })} />
            </Div>
            <div className={styles.narrow}>
              <TextInput
                aria-label={`End port ${index + 1}`}
                placeholder="end port"
                value={port.endPort === undefined ? "" : String(port.endPort)}
                onChange={(event) => {
                  const text = event.target.value.trim();

                  update({ endPort: /^\d+$/.test(text) ? Number(text) : undefined });
                }}
              />
            </div>
            <div className={styles.narrow}>
              <Select<string>
                ariaLabel={`Protocol ${index + 1}`}
                value={port.protocol ?? ""}
                options={[{ value: "", label: `default (${defaultProtocol})` }, ...protocols.filter((protocol) => model.kind !== "NetworkPolicy" || protocol !== "ANY").map((protocol) => ({ value: protocol, label: protocol }))]}
                onChange={(protocol) => update({ protocol: protocol === "" ? undefined : (protocol as Protocol) })}
              />
            </div>
            <PlainButton Icon={CloseIcon} $tooltip="Remove port" $onClick={() => onChange({ ...portRule, ports: portRule.ports.filter((other) => other.id !== port.id) })}>
              <Span $visuallyHidden>Remove port {index + 1}</Span>
            </PlainButton>
          </Div>
        );
      })}
      {l7 &&
        portRule.http.map((http, index) => {
          const update = (next: Partial<typeof http>) => onChange({ ...portRule, http: portRule.http.map((other) => (other.id === http.id ? { ...other, ...next } : other)) });

          return (
            <Div key={http.id} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
              <Badge small label="HTTP" />
              <div className={styles.narrow}>
                <TextInput aria-label={`HTTP rule ${index + 1} method`} placeholder="method" value={http.method} onChange={(event) => update({ method: event.target.value.trim() })} />
              </div>
              <Div $flexChild>
                <TextInput aria-label={`HTTP rule ${index + 1} path`} placeholder="path (regex, e.g. /api/.*)" value={http.path} onChange={(event) => update({ path: event.target.value.trim() })} />
              </Div>
              <Div $flexChild>
                <ListInput ariaLabel={`HTTP rule ${index + 1} headers`} placeholder="headers: X-Env: prod, …" value={http.headers} onChange={(headers) => update({ headers })} />
              </Div>
              <PlainButton Icon={CloseIcon} $tooltip="Remove HTTP rule" $onClick={() => onChange({ ...portRule, http: portRule.http.filter((other) => other.id !== http.id) })}>
                <Span $visuallyHidden>Remove HTTP rule {index + 1}</Span>
              </PlainButton>
            </Div>
          );
        })}
      {l7 &&
        portRule.dns.map((dns, index) => {
          const pattern = dns.matchPattern !== undefined;
          const update = (next: typeof dns) => onChange({ ...portRule, dns: portRule.dns.map((other) => (other.id === dns.id ? next : other)) });

          return (
            <Div key={dns.id} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
              <Badge small label="DNS" />
              <div className={styles.narrow}>
                <Select
                  ariaLabel={`DNS rule ${index + 1} kind`}
                  value={pattern ? "pattern" : "name"}
                  options={[
                    { value: "name", label: "matchName" },
                    { value: "pattern", label: "matchPattern" },
                  ]}
                  onChange={(mode) => update(mode === "pattern" ? { id: dns.id, matchPattern: dns.matchName ?? "*" } : { id: dns.id, matchName: dns.matchPattern ?? "" })}
                />
              </div>
              <Div $flexChild>
                <TextInput
                  aria-label={`DNS rule ${index + 1}`}
                  placeholder={pattern ? "*" : "api.example.com"}
                  value={dns.matchPattern ?? dns.matchName ?? ""}
                  onChange={(event) => update(pattern ? { id: dns.id, matchPattern: event.target.value.trim() } : { id: dns.id, matchName: event.target.value.trim() })}
                />
              </Div>
              <PlainButton Icon={CloseIcon} $tooltip="Remove DNS rule" $onClick={() => onChange({ ...portRule, dns: portRule.dns.filter((other) => other.id !== dns.id) })}>
                <Span $visuallyHidden>Remove DNS rule {index + 1}</Span>
              </PlainButton>
            </Div>
          );
        })}
      {(Object.keys(portRule.extra ?? {}).length > 0 || Object.keys(portRule.extraRules ?? {}).length > 0) && (
        <Span $font={{ size: "xs" }} $color="textMuted">
          Kept as written: {[...Object.keys(portRule.extra ?? {}), ...Object.keys(portRule.extraRules ?? {}).map((key) => `rules.${key}`)].join(", ")}
        </Span>
      )}
      <Div $flex={{ direction: "horizontal", gap: "xs", wrap: true }}>
        <PlainButton Icon={AddIcon} $onClick={() => onChange({ ...portRule, ports: [...portRule.ports, newPort("", model.kind === "NetworkPolicy" ? undefined : "TCP")] })}>
          Port
        </PlainButton>
        {l7 && (
          <PlainButton Icon={AddIcon} $enabled={portRule.dns.length === 0} $onClick={() => onChange({ ...portRule, http: [...portRule.http, { id: newId("http"), method: "GET", path: "", headers: [] }] })}>
            HTTP rule
          </PlainButton>
        )}
        {l7 && (
          <PlainButton Icon={AddIcon} $enabled={portRule.http.length === 0} $onClick={() => onChange({ ...portRule, dns: [...portRule.dns, { id: newId("dns"), matchPattern: "*" }] })}>
            DNS rule
          </PlainButton>
        )}
        <PlainButton Icon={DeleteIcon} $onClick={onRemove}>
          Remove port rule
        </PlainButton>
      </Div>
    </Div>
  );
};

const RuleCard = ({
  model,
  direction,
  rule,
  index,
  count,
  onChange,
  env,
}: {
  model: PolicyModel;
  direction: Direction;
  rule: RuleModel;
  index: number;
  count: number;
  onChange: (model: PolicyModel) => void;
  env: BuilderEnv;
}) => {
  const [over, setOver] = useState(false);
  const [addType, setAddType] = useState<PeerType>();
  const types = peerTypesFor(model.kind, direction, { cidrGroups: env.cidrGroupsInstalled });
  const summary = summarizeRule(model, direction, rule);
  const ruleGroup = rule.peers[0] ? l3GroupOf(rule.peers[0]) : undefined;

  const accepts = (event: DragEvent) => {
    const peerType = peerTypeOfDrag(event);

    return event.dataTransfer.types.includes(ruleMime(direction)) || (peerType !== undefined && types.includes(normalizePeerType(peerType)));
  };

  return (
    <div
      className={`${styles.rule} ${over ? styles.dropBefore : ""}`}
      role="group"
      aria-label={`${directionLabel[direction]} rule ${index + 1}`}
      onDragOver={(event) => {
        if (accepts(event)) {
          event.preventDefault();
          event.stopPropagation();
          setOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);

        if (!accepts(event)) return;

        event.preventDefault();
        event.stopPropagation();

        const from = event.dataTransfer.getData(ruleMime(direction));
        const peerType = peerTypeOfDrag(event);

        if (from !== "") {
          const fromIndex = Number(from);

          onChange(moveRule(model, direction, fromIndex, fromIndex < index ? index - 1 : index));
        } else if (peerType) {
          onChange(addPeerToRule(model, direction, rule.id, normalizePeerType(peerType)));
        }
      }}
    >
      <Div $flex={{ direction: "vertical", gap: "s" }}>
        <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
          <span
            className={styles.handle}
            draggable
            title="Drag to reorder (or use the arrows)"
            aria-hidden
            onDragStart={(event) => {
              event.dataTransfer.setData(ruleMime(direction), String(index));
              event.dataTransfer.effectAllowed = "move";

              const card = (event.currentTarget as HTMLElement).closest(`.${styles.rule}`);

              if (card) event.dataTransfer.setDragImage(card, 16, 16);
            }}
          >
            <OpenWithIcon $size="s" />
          </span>
          <Span $font={{ bold: true }}>Rule {index + 1}</Span>
          <Span $flexChild $color="textMuted" $font={{ size: "s" }} className={uiStyles.truncate} $tooltip={summary.text}>
            {summary.text}
          </Span>
          <PlainButton Icon={KeyboardArrowUpIcon} $enabled={index > 0} $tooltip="Move up" $onClick={() => onChange(moveRule(model, direction, index, index - 1))}>
            <Span $visuallyHidden>Move rule {index + 1} up</Span>
          </PlainButton>
          <PlainButton Icon={KeyboardArrowDownIcon} $enabled={index < count - 1} $tooltip="Move down" $onClick={() => onChange(moveRule(model, direction, index, index + 1))}>
            <Span $visuallyHidden>Move rule {index + 1} down</Span>
          </PlainButton>
          <PlainButton Icon={DeleteIcon} $tooltip="Remove rule" $onClick={() => onChange(removeRule(model, direction, rule.id))}>
            <Span $visuallyHidden>Remove rule {index + 1}</Span>
          </PlainButton>
        </Div>

        <Span $font={{ size: "xs", bold: true }} $color="textMuted">
          {direction.startsWith("egress") ? "TO" : "FROM"} {rule.peers.length === 0 ? (model.kind === "NetworkPolicy" || rule.portRules.length > 0 ? "— any peer" : "— no peer: this rule matches nothing") : ""}
        </Span>
        {rule.peers.map((peer) => (
          <Div key={peer.id} className={styles.peer} $flex={{ direction: "vertical", gap: "xs" }}>
            <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
              <Badge small label={peerTypeLabel[peer.type]} />
              <Div $flexChild />
              <PlainButton Icon={CloseIcon} $tooltip="Remove peer" $onClick={() => onChange(removePeer(model, direction, rule.id, peer.id))}>
                <Span $visuallyHidden>Remove {peerTypeLabel[peer.type]} peer</Span>
              </PlainButton>
            </Div>
            <PeerEditor model={model} direction={direction} peer={peer} env={env} onChange={(next) => onChange(updatePeer(model, direction, rule.id, peer.id, () => next))} />
          </Div>
        ))}
        <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
          <Div $width={{ width: "11xl" }}>
            <Select<PeerType>
              ariaLabel={`Peer type to add to rule ${index + 1}`}
              value={addType}
              placeholder="Add a peer…"
              options={types.map((type) => ({
                value: type,
                label: `${peerTypeLabel[type]}${model.kind !== "NetworkPolicy" && ruleGroup && ruleGroup !== l3GroupOf(newPeer(type)) ? " (as a new rule)" : ""}`,
              }))}
              onChange={setAddType}
            />
          </Div>
          <PlainButton
            Icon={AddIcon}
            $enabled={addType !== undefined}
            $onClick={() => {
              if (addType) onChange(addPeerToRule(model, direction, rule.id, addType));
              setAddType(undefined);
            }}
          >
            Add peer
          </PlainButton>
        </Div>

        <Span $font={{ size: "xs", bold: true }} $color="textMuted">
          PORTS {rule.portRules.length === 0 ? "— every port" : ""}
        </Span>
        {rule.portRules.map((portRule) => (
          <PortRuleEditor
            key={portRule.id}
            model={model}
            direction={direction}
            portRule={portRule}
            onChange={(next) => onChange(updateRule(model, direction, rule.id, (current) => ({ ...current, portRules: current.portRules.map((other) => (other.id === portRule.id ? next : other)) })))}
            onRemove={() => onChange(updateRule(model, direction, rule.id, (current) => ({ ...current, portRules: current.portRules.filter((other) => other.id !== portRule.id) })))}
          />
        ))}
        <Div>
          <PlainButton
            Icon={AddIcon}
            $enabled={model.kind !== "NetworkPolicy" || rule.portRules.length === 0}
            $onClick={() => onChange(updateRule(model, direction, rule.id, (current) => ({ ...current, portRules: [...current.portRules, newPortRule([newPort("", model.kind === "NetworkPolicy" ? "TCP" : "TCP")])] })))}
          >
            {isDeny(direction) || model.kind === "NetworkPolicy" ? "Ports" : "Ports and L7 rules"}
          </PlainButton>
        </Div>
        {Object.keys(rule.extra ?? {}).length > 0 && (
          <Span $font={{ size: "xs" }} $color="textMuted">
            Kept as written (not editable here): {Object.keys(rule.extra ?? {}).join(", ")}
          </Span>
        )}
      </Div>
    </div>
  );
};

/** A drop zone for one direction: palette entries dropped here become rules, rules dropped here move to its end. */
export const Lane = ({ model, direction, onChange, env }: { model: PolicyModel; direction: Direction; onChange: (model: PolicyModel) => void; env: BuilderEnv }) => {
  const [active, setActive] = useState(false);
  const [addType, setAddType] = useState<PeerType>();
  const section = model.sections[direction];
  const types = peerTypesFor(model.kind, direction, { cidrGroups: env.cidrGroupsInstalled });

  const accepts = (event: DragEvent) => {
    const peerType = peerTypeOfDrag(event);

    return event.dataTransfer.types.includes(ruleMime(direction)) || (peerType !== undefined && types.includes(normalizePeerType(peerType)));
  };

  return (
    <div
      className={`${styles.lane} ${uiStyles.dropZone} ${active ? uiStyles.dropZoneActive : ""}`}
      role="region"
      aria-label={`${directionLabel[direction]} rules`}
      onDragOver={(event) => {
        if (accepts(event)) {
          event.preventDefault();
          setActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false);
      }}
      onDrop={(event) => {
        setActive(false);

        if (!accepts(event)) return;

        event.preventDefault();

        const from = event.dataTransfer.getData(ruleMime(direction));
        const peerType = peerTypeOfDrag(event);

        if (from !== "") onChange(moveRule(model, direction, Number(from), section.rules.length));
        else if (peerType) onChange(addRuleWithPeer(model, direction, normalizePeerType(peerType)));
      }}
    >
      <Div $flex={{ direction: "vertical", gap: "s" }}>
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
          <Span $font={{ bold: true }} $flexChild>
            {directionLabel[direction]}
          </Span>
          <Checkbox
            checked={section.enabled}
            onChange={(enabled) => onChange(updateSection(model, direction, (current) => ({ ...current, enabled })))}
            label={isDeny(direction) ? "Include" : `Restrict ${direction}`}
            title={isDeny(direction) ? "Write this deny section" : `Write the ${direction} section: everything not allowed by a rule here (or by another policy) is denied`}
          />
        </Div>
        {!section.enabled && (
          <Span $color="textMuted" $font={{ size: "s" }}>
            {isDeny(direction) ? "No deny rules." : `Not restricted by this policy. Drop a peer type here, or add a rule, to restrict ${direction}.`}
          </Span>
        )}
        {section.enabled && section.rules.length === 0 && (
          <Span $color={isDeny(direction) ? "textMuted" : "warning"} $font={{ size: "s" }}>
            {isDeny(direction) ? "Empty: denies nothing." : `No rules: all ${direction} traffic is denied (default deny), except what other policies allow.`}
          </Span>
        )}
        {section.enabled &&
          section.rules.map((rule, index) => <RuleCard key={rule.id} model={model} direction={direction} rule={rule} index={index} count={section.rules.length} onChange={onChange} env={env} />)}
        <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
          <Div $width={{ width: "11xl" }}>
            <Select<PeerType> ariaLabel={`Peer type of a new ${directionLabel[direction]} rule`} value={addType} placeholder="New rule with peer…" options={types.map((type) => ({ value: type, label: peerTypeLabel[type] }))} onChange={setAddType} />
          </Div>
          <PlainButton
            Icon={AddIcon}
            $enabled={addType !== undefined}
            $onClick={() => {
              if (addType) onChange(addRuleWithPeer(model, direction, addType));
              setAddType(undefined);
            }}
          >
            Add rule
          </PlainButton>
        </Div>
      </Div>
    </div>
  );
};
