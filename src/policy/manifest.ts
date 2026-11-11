import { deepClone, isPlainObject, type Json, type JsonObject } from "../common/json";
import { cleanForEdit, cleanForExport } from "../common/manifest";
import {
  defaultApiVersion,
  type Direction,
  directions,
  type DnsRuleModel,
  emptySelector,
  type HttpRuleModel,
  isCiliumKind,
  isDeny,
  isEgress,
  isNamespacedKind,
  isPolicyKind,
  namespaceLabelKey,
  namespaceMetadataNameLabel,
  newId,
  type Peer,
  type PolicyKind,
  type PolicyModel,
  type PortModel,
  type PortRuleModel,
  type Protocol,
  protocols,
  type RuleModel,
  type SectionModel,
  type SelectorExpression,
  type SelectorModel,
  type SelectorOperator,
  selectorOperators,
} from "./model";

/** Cilium sees a namespace's labels on its endpoints under this prefix. */
export const namespaceLabelsPrefix = "k8s:io.cilium.k8s.namespace.labels.";

// ---- Selectors ----

export const selectorToJson = (selector: SelectorModel | undefined): JsonObject => {
  const json: JsonObject = {};

  if (!selector) {
    return json;
  }

  if (Object.keys(selector.matchLabels).length > 0) {
    json.matchLabels = { ...selector.matchLabels };
  }

  if (selector.matchExpressions.length > 0) {
    json.matchExpressions = selector.matchExpressions.map((expression) =>
      expression.operator === "Exists" || expression.operator === "DoesNotExist"
        ? { key: expression.key, operator: expression.operator }
        : { key: expression.key, operator: expression.operator, values: [...expression.values] },
    );
  }

  return json;
};

export const selectorFromJson = (json: Json): SelectorModel => {
  if (!isPlainObject(json)) {
    return emptySelector;
  }

  const matchLabels: Record<string, string> = {};

  for (const [key, value] of Object.entries(isPlainObject(json.matchLabels) ? json.matchLabels : {})) {
    matchLabels[key] = String(value ?? "");
  }

  const matchExpressions: SelectorExpression[] = (Array.isArray(json.matchExpressions) ? json.matchExpressions : [])
    .filter((expression: Json) => isPlainObject(expression) && typeof expression.key === "string")
    .map((expression: Json) => ({
      key: expression.key,
      operator: (selectorOperators.includes(expression.operator) ? expression.operator : "In") as SelectorOperator,
      values: Array.isArray(expression.values) ? expression.values.map(String) : [],
    }));

  return { matchLabels, matchExpressions };
};

const onlyKeys = (value: Json, allowed: readonly string[]) => isPlainObject(value) && Object.keys(value).every((key) => allowed.includes(key));

const without = (value: Json, keys: readonly string[]): JsonObject | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const rest: JsonObject = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!keys.includes(key)) {
      rest[key] = deepClone(entry);
    }
  }

  return Object.keys(rest).length > 0 ? rest : undefined;
};

/** Reorders an object's keys to follow a reference object's order, new keys last, so diffs show only real changes. */
export const orderLike = (value: JsonObject, reference: Json): JsonObject => {
  if (!isPlainObject(reference)) {
    return value;
  }

  const ordered: JsonObject = {};

  for (const key of Object.keys(reference)) {
    if (key in value) ordered[key] = value[key];
  }

  for (const key of Object.keys(value)) {
    if (!(key in ordered)) ordered[key] = value[key];
  }

  return ordered;
};

const protocolOf = (value: Json): Protocol | undefined => (protocols.includes(value) ? (value as Protocol) : undefined);

// ---- Building ----

/** The Cilium endpoint selector an endpoint or namespace peer is written as. */
export const ciliumPeerSelector = (peer: Peer): JsonObject => {
  if (peer.type === "endpoint") {
    return selectorToJson(peer.selector);
  }

  // namespace
  const pods = peer.podSelector ?? emptySelector;
  const labels: Record<string, string> = {};
  const expressions: SelectorExpression[] = [];

  if (peer.namespaceLabels) {
    for (const [key, value] of Object.entries(peer.namespaceLabels.matchLabels)) labels[`${namespaceLabelsPrefix}${key}`] = value;
    for (const expression of peer.namespaceLabels.matchExpressions) expressions.push({ ...expression, key: `${namespaceLabelsPrefix}${expression.key}` });
  } else {
    labels[namespaceLabelKey] = peer.namespaceName ?? "";
  }

  return selectorToJson({ matchLabels: { ...labels, ...pods.matchLabels }, matchExpressions: [...expressions, ...pods.matchExpressions] });
};

const buildCiliumPortRule = (portRule: PortRuleModel, deny: boolean, keepExtras: boolean): JsonObject => {
  const json: JsonObject = {};

  if (portRule.ports.length > 0) {
    json.ports = portRule.ports.map((port) => ({
      port: port.port,
      ...(port.endPort !== undefined ? { endPort: port.endPort } : {}),
      ...(port.protocol ? { protocol: port.protocol } : {}),
    }));
  }

  if (!deny) {
    const rules: JsonObject = keepExtras ? { ...(deepClone(portRule.extraRules) ?? {}) } : {};

    if (portRule.http.length > 0) {
      rules.http = portRule.http.map((http) => ({
        ...(keepExtras ? deepClone(http.extra) ?? {} : {}),
        ...(http.method ? { method: http.method } : {}),
        ...(http.path ? { path: http.path } : {}),
        ...(http.headers.length > 0 ? { headers: [...http.headers] } : {}),
      }));
    }

    if (portRule.dns.length > 0) {
      rules.dns = portRule.dns.map((dns) => (dns.matchPattern !== undefined ? { matchPattern: dns.matchPattern } : { matchName: dns.matchName ?? "" }));
    }

    if (Object.keys(rules).length > 0) {
      json.rules = rules;
    }
  }

  return keepExtras && portRule.extra ? { ...json, ...deepClone(portRule.extra) } : json;
};

const buildCiliumRule = (rule: RuleModel, direction: Direction, keepExtras: boolean): JsonObject => {
  const prefix = isEgress(direction) ? "to" : "from";
  const json: JsonObject = {};
  const push = (field: string, entry: Json) => {
    json[field] = [...(json[field] ?? []), entry];
  };
  const useSet = rule.peers.some(
    (peer) => peer.type === "cidrGroup" || (peer.type === "cidr" && (peer.asSet || (peer.except ?? []).length > 0)) || (peer.type === "raw" && peer.field === `${prefix}CIDRSet`),
  );

  for (const peer of rule.peers) {
    switch (peer.type) {
      case "endpoint":
      case "namespace":
        push(`${prefix}Endpoints`, ciliumPeerSelector(peer));
        break;
      case "entity":
        for (const entity of peer.entities ?? []) {
          if (!(json[`${prefix}Entities`] ?? []).includes(entity)) push(`${prefix}Entities`, entity);
        }
        break;
      case "cidr":
        if (useSet) {
          push(`${prefix}CIDRSet`, { ...(keepExtras ? deepClone(peer.extra) ?? {} : {}), cidr: peer.cidr ?? "", ...((peer.except ?? []).length > 0 ? { except: [...peer.except!] } : {}) });
        } else {
          push(`${prefix}CIDR`, peer.cidr ?? "");
        }
        break;
      case "cidrGroup":
        push(`${prefix}CIDRSet`, { ...(keepExtras ? deepClone(peer.extra) ?? {} : {}), cidrGroupRef: peer.cidrGroupRef ?? "" });
        break;
      case "fqdn":
        push("toFQDNs", peer.matchPattern !== undefined ? { matchPattern: peer.matchPattern } : { matchName: peer.matchName ?? "" });
        break;
      case "service": {
        const namespace = peer.serviceNamespace ? { namespace: peer.serviceNamespace } : {};

        push(
          "toServices",
          peer.selector && !peer.serviceName
            ? { k8sServiceSelector: { selector: selectorToJson(peer.selector), ...namespace } }
            : { k8sService: { serviceName: peer.serviceName ?? "", ...namespace } },
        );
        break;
      }
      case "raw":
        if (keepExtras && peer.field) push(peer.field, deepClone(peer.raw));
        break;
    }
  }

  if (rule.portRules.length > 0) {
    json.toPorts = rule.portRules.map((portRule) => buildCiliumPortRule(portRule, isDeny(direction), keepExtras));
  }

  return keepExtras && rule.extra ? { ...json, ...deepClone(rule.extra) } : json;
};

const portValue = (port: string): string | number => (/^\d+$/.test(port) ? Number(port) : port);

const buildNetworkPolicyRule = (rule: RuleModel, direction: Direction, keepExtras: boolean): JsonObject => {
  const json: JsonObject = keepExtras ? { ...(deepClone(rule.extra) ?? {}) } : {};
  const peers: Json[] = [];

  for (const peer of rule.peers) {
    switch (peer.type) {
      case "endpoint":
        peers.push({ podSelector: selectorToJson(peer.selector) });
        break;
      case "namespace":
        peers.push({
          namespaceSelector: peer.namespaceLabels ? selectorToJson(peer.namespaceLabels) : { matchLabels: { [namespaceMetadataNameLabel]: peer.namespaceName ?? "" } },
          ...(peer.podSelector ? { podSelector: selectorToJson(peer.podSelector) } : {}),
        });
        break;
      case "cidr":
        peers.push({ ipBlock: { ...(keepExtras ? deepClone(peer.extra) ?? {} : {}), cidr: peer.cidr ?? "", ...((peer.except ?? []).length > 0 ? { except: [...peer.except!] } : {}) } });
        break;
      case "raw":
        if (keepExtras) peers.push(deepClone(peer.raw));
        break;
      default:
        // Entities, FQDNs, Services and CIDR groups are Cilium features; `policyModelIssues` reports them.
        break;
    }
  }

  if (peers.length > 0) {
    json[isEgress(direction) ? "to" : "from"] = peers;
  }

  const ports = rule.portRules.flatMap((portRule) => portRule.ports);

  if (ports.length > 0) {
    json.ports = ports.map((port) => ({
      ...(port.protocol && port.protocol !== "ANY" ? { protocol: port.protocol } : {}),
      ...(port.port !== "" ? { port: portValue(port.port) } : {}),
      ...(port.endPort !== undefined ? { endPort: port.endPort } : {}),
    }));
  }

  return json;
};

const familyOf = (kind: unknown) => (kind === "NetworkPolicy" ? "k8s" : "cilium");

const buildCiliumSpec = (model: PolicyModel, keepExtras: boolean): JsonObject => {
  const spec: JsonObject = keepExtras ? { ...(deepClone(model.specExtra) ?? {}) } : {};

  if (model.kind === "CiliumClusterwideNetworkPolicy" && model.subject === "nodes") {
    spec.nodeSelector = selectorToJson(model.selector);
  } else {
    spec.endpointSelector = selectorToJson(model.selector);
  }

  if (model.description.trim()) {
    spec.description = model.description;
  }

  for (const direction of directions) {
    const section = model.sections[direction];

    if (section.enabled) {
      spec[direction] = section.rules.length === 0 ? (section.emptyForm === "list" ? [] : [{}]) : section.rules.map((rule) => buildCiliumRule(rule, direction, keepExtras));
    }
  }

  return spec;
};

const buildNetworkPolicySpec = (model: PolicyModel, keepExtras: boolean, baseSpec: Json): JsonObject => {
  const spec: JsonObject = keepExtras ? { ...(deepClone(model.specExtra) ?? {}) } : {};
  const { ingress, egress } = model.sections;

  spec.podSelector = selectorToJson(model.selector);

  const policyTypes = [...(ingress.enabled ? ["Ingress"] : []), ...(egress.enabled ? ["Egress"] : [])];
  // Without policyTypes Kubernetes assumes Ingress, plus Egress when there are egress rules: keep it left out when that says the same.
  const implied = ["Ingress", ...(egress.rules.length > 0 ? ["Egress"] : [])];
  const leaveOut = isPlainObject(baseSpec) && baseSpec.policyTypes === undefined && policyTypes.join() === implied.join();

  if (policyTypes.length > 0 && !leaveOut) {
    spec.policyTypes = policyTypes;
  }

  if (ingress.enabled && ingress.rules.length > 0) {
    spec.ingress = ingress.rules.map((rule) => buildNetworkPolicyRule(rule, "ingress", keepExtras));
  }

  if (egress.enabled && egress.rules.length > 0) {
    spec.egress = egress.rules.map((rule) => buildNetworkPolicyRule(rule, "egress", keepExtras));
  }

  return spec;
};

/** Whether the model still describes the resource it was read from (same kind, name and namespace). */
export const isSameResource = (model: PolicyModel): boolean => {
  const base = model.base;

  return (
    isPlainObject(base) &&
    base.kind === model.kind &&
    base.metadata?.name === model.name &&
    (!isNamespacedKind(model.kind) || (base.metadata?.namespace ?? "") === model.namespace)
  );
};

/** Turns the builder's model into the manifest to apply, keeping every field of the original it does not model. */
export const buildManifest = (model: PolicyModel): JsonObject => {
  const base = isPlainObject(model.base) ? model.base : undefined;
  const same = isSameResource(model);
  const keepExtras = !base || familyOf(base.kind) === familyOf(model.kind);
  const start: JsonObject = base ? (same ? cleanForEdit(base) : cleanForExport(base)) : {};

  delete start.status;

  const metadata: JsonObject = { ...(isPlainObject(start.metadata) ? start.metadata : {}), name: model.name };

  if (isNamespacedKind(model.kind)) {
    metadata.namespace = model.namespace;
  } else {
    delete metadata.namespace;
  }

  const baseSpec = base && model.specLocation !== undefined && keepExtras ? (model.specLocation === "spec" ? base.spec : base.specs?.[model.specLocation]) : undefined;
  const spec = orderLike(isCiliumKind(model.kind) ? buildCiliumSpec(model, keepExtras) : buildNetworkPolicySpec(model, keepExtras, baseSpec), baseSpec);
  const document: JsonObject = {
    ...start,
    apiVersion: base && base.kind === model.kind && base.apiVersion ? base.apiVersion : defaultApiVersion(model.kind),
    kind: model.kind,
    metadata,
  };

  if (typeof model.specLocation === "number" && base && keepExtras && Array.isArray(base.specs)) {
    const specs = deepClone(base.specs) as Json[];

    specs[model.specLocation] = spec;
    document.specs = specs;
    delete document.spec;
  } else {
    document.spec = spec;
    delete document.specs;
  }

  return orderLike(document, { apiVersion: 1, kind: 1, metadata: 1, spec: 1, specs: 1 });
};

// ---- Parsing ----

const rawPeer = (field: string, raw: Json): Peer => ({ id: newId("peer"), type: "raw", field, raw: deepClone(raw) });

const parseCiliumEndpointEntry = (entry: Json, field: string): Peer => {
  if (!onlyKeys(entry, ["matchLabels", "matchExpressions"])) {
    return rawPeer(field, entry);
  }

  const selector = selectorFromJson(entry);
  const labelKeys = Object.keys(selector.matchLabels);

  if (labelKeys.length === 1 && labelKeys[0] === namespaceLabelKey && selector.matchExpressions.length === 0) {
    return { id: newId("peer"), type: "namespace", namespaceName: selector.matchLabels[namespaceLabelKey] };
  }

  return { id: newId("peer"), type: "endpoint", selector };
};

const parsePortRule = (entry: Json): PortRuleModel => {
  const ports: PortModel[] = (Array.isArray(entry?.ports) ? entry.ports : []).map((port: Json) => ({
    id: newId("port"),
    port: port?.port === undefined ? "" : String(port.port),
    ...(typeof port?.endPort === "number" ? { endPort: port.endPort } : {}),
    ...(protocolOf(port?.protocol) ? { protocol: protocolOf(port.protocol) } : {}),
  }));
  const rules = isPlainObject(entry?.rules) ? entry.rules : {};
  const http: HttpRuleModel[] = (Array.isArray(rules.http) ? rules.http : []).map((rule: Json) => ({
    id: newId("http"),
    method: typeof rule?.method === "string" ? rule.method : "",
    path: typeof rule?.path === "string" ? rule.path : "",
    headers: Array.isArray(rule?.headers) ? rule.headers.map(String) : [],
    extra: without(rule, ["method", "path", "headers"]),
  }));
  const dns: DnsRuleModel[] = (Array.isArray(rules.dns) ? rules.dns : []).map((rule: Json) =>
    typeof rule?.matchPattern === "string" ? { id: newId("dns"), matchPattern: rule.matchPattern } : { id: newId("dns"), matchName: String(rule?.matchName ?? "") },
  );

  return { id: newId("ports"), ports, http, dns, extra: without(entry, ["ports", "rules"]), extraRules: without(rules, ["http", "dns"]) };
};

const parseCiliumRule = (rule: Json, direction: Direction): RuleModel => {
  const prefix = isEgress(direction) ? "to" : "from";
  const peers: Peer[] = [];
  const handled = [`${prefix}Endpoints`, `${prefix}CIDR`, `${prefix}CIDRSet`, `${prefix}Entities`, "toPorts"];

  if (direction === "egress") handled.push("toFQDNs", "toServices");
  if (direction === "egressDeny") handled.push("toServices");

  const list = (field: string): Json[] => (handled.includes(field) && Array.isArray(rule?.[field]) ? rule[field] : []);

  for (const entry of list(`${prefix}Endpoints`)) peers.push(parseCiliumEndpointEntry(entry, `${prefix}Endpoints`));
  for (const entry of list(`${prefix}CIDR`)) {
    peers.push(typeof entry === "string" ? { id: newId("peer"), type: "cidr", cidr: entry, except: [] } : rawPeer(`${prefix}CIDR`, entry));
  }
  for (const entry of list(`${prefix}CIDRSet`)) {
    if (typeof entry?.cidr === "string") {
      peers.push({ id: newId("peer"), type: "cidr", cidr: entry.cidr, except: Array.isArray(entry.except) ? entry.except.map(String) : [], asSet: true, extra: without(entry, ["cidr", "except"]) });
    } else if (typeof entry?.cidrGroupRef === "string") {
      peers.push({ id: newId("peer"), type: "cidrGroup", cidrGroupRef: entry.cidrGroupRef, extra: without(entry, ["cidrGroupRef"]) });
    } else {
      peers.push(rawPeer(`${prefix}CIDRSet`, entry));
    }
  }
  const entities = list(`${prefix}Entities`).map(String);

  if (entities.length > 0) peers.push({ id: newId("peer"), type: "entity", entities });
  for (const entry of list("toFQDNs")) {
    if (onlyKeys(entry, ["matchPattern"]) && typeof entry.matchPattern === "string") peers.push({ id: newId("peer"), type: "fqdn", matchPattern: entry.matchPattern });
    else if (onlyKeys(entry, ["matchName"]) && typeof entry.matchName === "string") peers.push({ id: newId("peer"), type: "fqdn", matchName: entry.matchName });
    else peers.push(rawPeer("toFQDNs", entry));
  }
  for (const entry of list("toServices")) {
    if (onlyKeys(entry, ["k8sService"]) && onlyKeys(entry.k8sService, ["serviceName", "namespace"])) {
      peers.push({ id: newId("peer"), type: "service", serviceName: String(entry.k8sService.serviceName ?? ""), serviceNamespace: entry.k8sService.namespace ?? "" });
    } else if (onlyKeys(entry, ["k8sServiceSelector"]) && onlyKeys(entry.k8sServiceSelector, ["selector", "namespace"])) {
      peers.push({ id: newId("peer"), type: "service", selector: selectorFromJson(entry.k8sServiceSelector.selector), serviceNamespace: entry.k8sServiceSelector.namespace ?? "" });
    } else {
      peers.push(rawPeer("toServices", entry));
    }
  }

  return { id: newId("rule"), peers, portRules: list("toPorts").map(parsePortRule), extra: without(rule, handled) };
};

const parseNetworkPolicyPeer = (entry: Json, field: string): Peer => {
  if (onlyKeys(entry, ["ipBlock"]) && typeof entry.ipBlock?.cidr === "string") {
    return { id: newId("peer"), type: "cidr", cidr: entry.ipBlock.cidr, except: Array.isArray(entry.ipBlock.except) ? entry.ipBlock.except.map(String) : [], extra: without(entry.ipBlock, ["cidr", "except"]) };
  }

  if (onlyKeys(entry, ["namespaceSelector", "podSelector"]) && isPlainObject(entry.namespaceSelector)) {
    const namespaces = selectorFromJson(entry.namespaceSelector);
    const labelKeys = Object.keys(namespaces.matchLabels);
    const byName = labelKeys.length === 1 && labelKeys[0] === namespaceMetadataNameLabel && namespaces.matchExpressions.length === 0 && onlyKeys(entry.namespaceSelector, ["matchLabels"]);

    return {
      id: newId("peer"),
      type: "namespace",
      ...(byName ? { namespaceName: namespaces.matchLabels[namespaceMetadataNameLabel] } : { namespaceLabels: namespaces }),
      ...(entry.podSelector !== undefined ? { podSelector: selectorFromJson(entry.podSelector) } : {}),
    };
  }

  if (onlyKeys(entry, ["podSelector"]) && isPlainObject(entry.podSelector)) {
    return { id: newId("peer"), type: "endpoint", selector: selectorFromJson(entry.podSelector) };
  }

  return rawPeer(field, entry);
};

const parseNetworkPolicyRule = (rule: Json, direction: Direction): RuleModel => {
  const field = isEgress(direction) ? "to" : "from";
  const peers = (Array.isArray(rule?.[field]) ? rule[field] : []).map((entry: Json) => parseNetworkPolicyPeer(entry, field));
  const ports: PortModel[] = (Array.isArray(rule?.ports) ? rule.ports : []).map((port: Json) => ({
    id: newId("port"),
    port: port?.port === undefined ? "" : String(port.port),
    ...(typeof port?.endPort === "number" ? { endPort: port.endPort } : {}),
    ...(protocolOf(port?.protocol) ? { protocol: protocolOf(port.protocol) } : {}),
  }));

  return { id: newId("rule"), peers, portRules: ports.length > 0 ? [{ id: newId("ports"), ports, http: [], dns: [] }] : [], extra: without(rule, [field, "ports"]) };
};

const parseCiliumSection = (value: Json, direction: Direction): SectionModel => {
  if (!Array.isArray(value)) {
    return { enabled: false, rules: [] };
  }

  if (value.length === 0) {
    return { enabled: true, rules: [], emptyForm: "list" };
  }

  if (value.length === 1 && isPlainObject(value[0]) && Object.keys(value[0]).length === 0) {
    return { enabled: true, rules: [], emptyForm: "emptyRule" };
  }

  return { enabled: true, rules: value.map((rule) => parseCiliumRule(rule, direction)) };
};

export class PolicyParseError extends Error {}

/** Reads a policy manifest into the builder's model; the manifest is kept as `base` so unmodelled fields survive `buildManifest`. */
export const parsePolicy = (manifest: Json): PolicyModel => {
  if (!isPlainObject(manifest) || !isPolicyKind(manifest.kind)) {
    throw new PolicyParseError(`Not a network policy: ${isPlainObject(manifest) ? String(manifest.kind) : typeof manifest}`);
  }

  const kind = manifest.kind as PolicyKind;
  const base = cleanForEdit(manifest);

  delete base.status;

  const specLocation: "spec" | number = isPlainObject(manifest.spec) || !Array.isArray(manifest.specs) || manifest.specs.length === 0 ? "spec" : 0;
  const spec: Json = specLocation === "spec" ? (manifest.spec ?? {}) : manifest.specs[0];
  const common = {
    kind,
    name: String(manifest.metadata?.name ?? ""),
    namespace: isNamespacedKind(kind) ? String(manifest.metadata?.namespace ?? "default") : "",
    base,
    specLocation,
  };

  if (kind === "NetworkPolicy") {
    const policyTypes: string[] | undefined = Array.isArray(spec.policyTypes) ? spec.policyTypes : undefined;
    const ingressRules = Array.isArray(spec.ingress) ? spec.ingress : [];
    const egressRules = Array.isArray(spec.egress) ? spec.egress : [];

    return {
      ...common,
      description: "",
      subject: "endpoints",
      selector: selectorFromJson(spec.podSelector),
      sections: {
        ingress: { enabled: policyTypes ? policyTypes.includes("Ingress") : true, rules: ingressRules.map((rule: Json) => parseNetworkPolicyRule(rule, "ingress")) },
        egress: { enabled: policyTypes ? policyTypes.includes("Egress") : egressRules.length > 0, rules: egressRules.map((rule: Json) => parseNetworkPolicyRule(rule, "egress")) },
        ingressDeny: { enabled: false, rules: [] },
        egressDeny: { enabled: false, rules: [] },
      },
      specExtra: without(spec, ["podSelector", "policyTypes", "ingress", "egress"]),
    };
  }

  const nodes = kind === "CiliumClusterwideNetworkPolicy" && spec.nodeSelector !== undefined && spec.endpointSelector === undefined;

  return {
    ...common,
    description: typeof spec.description === "string" ? spec.description : "",
    subject: nodes ? "nodes" : "endpoints",
    selector: selectorFromJson(nodes ? spec.nodeSelector : spec.endpointSelector),
    sections: {
      ingress: parseCiliumSection(spec.ingress, "ingress"),
      egress: parseCiliumSection(spec.egress, "egress"),
      ingressDeny: parseCiliumSection(spec.ingressDeny, "ingressDeny"),
      egressDeny: parseCiliumSection(spec.egressDeny, "egressDeny"),
    },
    specExtra: without(spec, ["endpointSelector", "nodeSelector", "description", ...directions]),
  };
};

/** Switches the kind the builder writes, keeping everything that carries over; the rest is reported by `policyModelIssues`. */
export const changeKind = (model: PolicyModel, kind: PolicyKind): PolicyModel => ({
  ...model,
  kind,
  subject: kind === "CiliumClusterwideNetworkPolicy" ? model.subject : "endpoints",
  namespace: isNamespacedKind(kind) ? model.namespace || "default" : model.namespace,
});

