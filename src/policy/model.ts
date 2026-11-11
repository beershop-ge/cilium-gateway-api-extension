import type { Json, JsonObject } from "../common/json";

/**
 * The network policy builder's model: what the builder edits, independent of the manifest's shape.
 * `manifest.ts` turns it into a CiliumNetworkPolicy, CiliumClusterwideNetworkPolicy or NetworkPolicy and back,
 * keeping every field the model does not cover in the `extra` bags so editing never loses them.
 */

export type PolicyKind = "CiliumNetworkPolicy" | "CiliumClusterwideNetworkPolicy" | "NetworkPolicy";

export const policyKinds: readonly PolicyKind[] = ["CiliumNetworkPolicy", "CiliumClusterwideNetworkPolicy", "NetworkPolicy"];

export const isPolicyKind = (kind: unknown): kind is PolicyKind => policyKinds.includes(kind as PolicyKind);

export const isCiliumKind = (kind: PolicyKind) => kind !== "NetworkPolicy";

export const isNamespacedKind = (kind: PolicyKind) => kind !== "CiliumClusterwideNetworkPolicy";

export const defaultApiVersion = (kind: PolicyKind) => (kind === "NetworkPolicy" ? "networking.k8s.io/v1" : "cilium.io/v2");

export type Direction = "ingress" | "egress" | "ingressDeny" | "egressDeny";

export const directions: readonly Direction[] = ["ingress", "egress", "ingressDeny", "egressDeny"];

export const directionLabel: Record<Direction, string> = {
  ingress: "Ingress (allow)",
  egress: "Egress (allow)",
  ingressDeny: "Ingress deny",
  egressDeny: "Egress deny",
};

export const isEgress = (direction: Direction) => direction === "egress" || direction === "egressDeny";

export const isDeny = (direction: Direction) => direction === "ingressDeny" || direction === "egressDeny";

export type PeerType = "endpoint" | "namespace" | "entity" | "cidr" | "cidrGroup" | "fqdn" | "service" | "raw";

/** The peer types the palette offers, in order. */
export const palettePeerTypes: readonly Exclude<PeerType, "raw">[] = ["endpoint", "namespace", "entity", "cidr", "fqdn", "service", "cidrGroup"];

export const peerTypeLabel: Record<PeerType, string> = {
  endpoint: "Endpoint",
  namespace: "Namespace",
  entity: "Entity",
  cidr: "CIDR",
  cidrGroup: "CIDR group",
  fqdn: "FQDN",
  service: "Service",
  raw: "Other (kept as written)",
};

export const ciliumEntities = ["world", "cluster", "host", "remote-node", "kube-apiserver", "health", "init", "ingress", "unmanaged", "all"] as const;

export type SelectorOperator = "In" | "NotIn" | "Exists" | "DoesNotExist";

export const selectorOperators: readonly SelectorOperator[] = ["In", "NotIn", "Exists", "DoesNotExist"];

export interface SelectorExpression {
  readonly key: string;
  readonly operator: SelectorOperator;
  readonly values: readonly string[];
}

export interface SelectorModel {
  readonly matchLabels: Readonly<Record<string, string>>;
  readonly matchExpressions: readonly SelectorExpression[];
}

export const emptySelector: SelectorModel = { matchLabels: {}, matchExpressions: [] };

export const selectorIsEmpty = (selector: SelectorModel | undefined) =>
  !selector || (Object.keys(selector.matchLabels).length === 0 && selector.matchExpressions.length === 0);

export interface Peer {
  readonly id: string;
  readonly type: PeerType;
  /** endpoint: the endpoint (Cilium) or pod (NetworkPolicy) selector. service: the Service selector. */
  readonly selector?: SelectorModel;
  /** namespace: the namespace by name (preferred), or by its labels. */
  readonly namespaceName?: string;
  readonly namespaceLabels?: SelectorModel;
  /** namespace: narrows to pods of the namespace; undefined means all pods. */
  readonly podSelector?: SelectorModel;
  /** entity */
  readonly entities?: readonly string[];
  /** cidr */
  readonly cidr?: string;
  readonly except?: readonly string[];
  /** cidr: written as a CIDRSet entry rather than a plain CIDR (always so when it has exceptions). */
  readonly asSet?: boolean;
  /** cidrGroup: a CiliumCIDRGroup name */
  readonly cidrGroupRef?: string;
  /** fqdn: exactly one of the two */
  readonly matchName?: string;
  readonly matchPattern?: string;
  /** service: by name, or by selector (`selector`), in a namespace */
  readonly serviceName?: string;
  readonly serviceNamespace?: string;
  /** raw: an entry the builder does not model, written back as it was, under `field`. */
  readonly field?: string;
  readonly raw?: Json;
  /** Fields of the entry the builder does not model, kept. */
  readonly extra?: JsonObject;
}

export type Protocol = "TCP" | "UDP" | "SCTP" | "ANY";

export const protocols: readonly Protocol[] = ["TCP", "UDP", "SCTP", "ANY"];

export interface PortModel {
  readonly id: string;
  /** A number or a named port, as text. */
  readonly port: string;
  readonly endPort?: number;
  /** Undefined leaves it to the default (ANY for Cilium, TCP for NetworkPolicy). */
  readonly protocol?: Protocol;
}

export interface HttpRuleModel {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  /** `Header-Name: value` or `Header-Name` lines. */
  readonly headers: readonly string[];
  readonly extra?: JsonObject;
}

export interface DnsRuleModel {
  readonly id: string;
  readonly matchName?: string;
  readonly matchPattern?: string;
}

export interface PortRuleModel {
  readonly id: string;
  readonly ports: readonly PortModel[];
  readonly http: readonly HttpRuleModel[];
  readonly dns: readonly DnsRuleModel[];
  /** Fields of the port rule the builder does not model (TLS, serverNames, listener, other L7 rules). */
  readonly extra?: JsonObject;
  /** Fields of `rules` the builder does not model (kafka, l7proto, l7). */
  readonly extraRules?: JsonObject;
}

export interface RuleModel {
  readonly id: string;
  /** No peers means any peer. */
  readonly peers: readonly Peer[];
  /** No port rules means every port. */
  readonly portRules: readonly PortRuleModel[];
  /** Fields of the rule the builder does not model (icmps, authentication, fromRequires, toNodes, …). */
  readonly extra?: JsonObject;
}

export interface SectionModel {
  /** Whether the section exists. Enabled with no rules is a default deny for that direction. */
  readonly enabled: boolean;
  readonly rules: readonly RuleModel[];
  /** How an enabled, empty Cilium section was written: `[]` or `[{}]` (the default). */
  readonly emptyForm?: "list" | "emptyRule";
}

export interface PolicyModel {
  readonly kind: PolicyKind;
  readonly name: string;
  readonly namespace: string;
  readonly description: string;
  /** Cilium clusterwide policies may select nodes (host policies) instead of endpoints. */
  readonly subject: "endpoints" | "nodes";
  readonly selector: SelectorModel;
  readonly sections: Readonly<Record<Direction, SectionModel>>;
  /** The manifest this model was read from, kept so fields the builder does not model survive. */
  readonly base?: Json;
  /** Spec fields the builder does not model. */
  readonly specExtra?: JsonObject;
  /** Where the edited spec sits in `base`: `spec`, or an index of `specs`. */
  readonly specLocation?: "spec" | number;
}

let counter = 0;

export const newId = (prefix = "id") => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const emptySection: SectionModel = { enabled: false, rules: [] };

export const newPolicyModel = (kind: PolicyKind = "CiliumNetworkPolicy", namespace = "default"): PolicyModel => ({
  kind,
  name: "",
  namespace,
  description: "",
  subject: "endpoints",
  selector: emptySelector,
  sections: { ingress: emptySection, egress: emptySection, ingressDeny: emptySection, egressDeny: emptySection },
});

/** Which peer types a direction of a kind accepts. */
export const peerTypesFor = (kind: PolicyKind, direction: Direction, { cidrGroups = true }: { cidrGroups?: boolean } = {}): PeerType[] => {
  if (kind === "NetworkPolicy") {
    return isDeny(direction) ? [] : ["endpoint", "namespace", "cidr"];
  }

  const types: PeerType[] = ["endpoint", "namespace", "entity", "cidr"];

  if (cidrGroups) types.push("cidrGroup");
  if (direction === "egress") types.push("fqdn", "service");
  if (direction === "egressDeny") types.push("service");

  return types;
};

export const directionsFor = (kind: PolicyKind): Direction[] => (kind === "NetworkPolicy" ? ["ingress", "egress"] : [...directions]);

/** L7 rules exist only on Cilium allow rules. */
export const supportsL7 = (kind: PolicyKind, direction: Direction) => kind !== "NetworkPolicy" && !isDeny(direction);

/**
 * Cilium refuses a rule combining different L3 selectors (fromEndpoints with fromCIDR, …).
 * This names the selector field a peer becomes, to tell which peers can share a rule.
 */
export const l3GroupOf = (peer: Peer): string => {
  switch (peer.type) {
    case "endpoint":
    case "namespace":
      return "Endpoints";
    case "cidr":
    case "cidrGroup":
      return "CIDR";
    case "entity":
      return "Entities";
    case "fqdn":
      return "FQDNs";
    case "service":
      return "Services";
    case "raw": {
      const field = (peer.field ?? "raw").replace(/^(from|to)/, "");

      return field === "CIDRSet" ? "CIDR" : field;
    }
  }
};

export const newPeer = (type: PeerType): Peer => {
  const id = newId("peer");

  switch (type) {
    case "endpoint":
      return { id, type, selector: emptySelector };
    case "namespace":
      return { id, type, namespaceName: "" };
    case "entity":
      return { id, type, entities: ["world"] };
    case "cidr":
      return { id, type, cidr: "", except: [] };
    case "cidrGroup":
      return { id, type, cidrGroupRef: "" };
    case "fqdn":
      return { id, type, matchName: "" };
    case "service":
      return { id, type, serviceName: "", serviceNamespace: "" };
    case "raw":
      return { id, type, raw: {} };
  }
};

export const newPort = (port = "", protocol?: Protocol): PortModel => ({ id: newId("port"), port, ...(protocol ? { protocol } : {}) });

export const newPortRule = (ports: readonly PortModel[] = [newPort("", "TCP")]): PortRuleModel => ({ id: newId("ports"), ports, http: [], dns: [] });

export const newRule = (peers: readonly Peer[] = []): RuleModel => ({ id: newId("rule"), peers, portRules: [] });

// ---- Immutable updates, used by the builder's components ----

export const updateSection = (model: PolicyModel, direction: Direction, update: (section: SectionModel) => SectionModel): PolicyModel => ({
  ...model,
  sections: { ...model.sections, [direction]: update(model.sections[direction]) },
});

export const updateRule = (model: PolicyModel, direction: Direction, ruleId: string, update: (rule: RuleModel) => RuleModel): PolicyModel =>
  updateSection(model, direction, (section) => ({ ...section, rules: section.rules.map((rule) => (rule.id === ruleId ? update(rule) : rule)) }));

export const addRule = (model: PolicyModel, direction: Direction, rule: RuleModel = newRule()): PolicyModel =>
  updateSection(model, direction, (section) => ({ ...section, enabled: true, rules: [...section.rules, rule] }));

/** What dropping a palette item on a lane does: a new rule with one peer of that type. */
export const addRuleWithPeer = (model: PolicyModel, direction: Direction, type: PeerType): PolicyModel => addRule(model, direction, newRule([newPeer(type)]));

export const removeRule = (model: PolicyModel, direction: Direction, ruleId: string): PolicyModel =>
  updateSection(model, direction, (section) => ({ ...section, rules: section.rules.filter((rule) => rule.id !== ruleId) }));

/** Moves a rule to another position of its section; `to` is clamped. */
export const moveRule = (model: PolicyModel, direction: Direction, from: number, to: number): PolicyModel =>
  updateSection(model, direction, (section) => {
    const rules = [...section.rules];

    if (from < 0 || from >= rules.length) {
      return section;
    }

    const [moved] = rules.splice(from, 1);

    rules.splice(Math.max(0, Math.min(rules.length, to)), 0, moved);

    return { ...section, rules };
  });

/**
 * Adds a peer to a rule when Cilium allows it there (same L3 selector as the rule's other peers);
 * otherwise adds a new rule right after it holding the peer. Returns the model unchanged for a rule that does not exist.
 */
export const addPeerToRule = (model: PolicyModel, direction: Direction, ruleId: string, type: PeerType): PolicyModel => {
  const section = model.sections[direction];
  const index = section.rules.findIndex((rule) => rule.id === ruleId);

  if (index < 0) {
    return model;
  }

  const peer = newPeer(type);
  const rule = section.rules[index];
  const compatible = model.kind === "NetworkPolicy" || rule.peers.every((other) => l3GroupOf(other) === l3GroupOf(peer));

  if (compatible) {
    return updateRule(model, direction, ruleId, (current) => ({ ...current, peers: [...current.peers, peer] }));
  }

  return updateSection(model, direction, (current) => {
    const rules = [...current.rules];

    rules.splice(index + 1, 0, newRule([peer]));

    return { ...current, rules };
  });
};

export const updatePeer = (model: PolicyModel, direction: Direction, ruleId: string, peerId: string, update: (peer: Peer) => Peer): PolicyModel =>
  updateRule(model, direction, ruleId, (rule) => ({ ...rule, peers: rule.peers.map((peer) => (peer.id === peerId ? update(peer) : peer)) }));

export const removePeer = (model: PolicyModel, direction: Direction, ruleId: string, peerId: string): PolicyModel =>
  updateRule(model, direction, ruleId, (rule) => ({ ...rule, peers: rule.peers.filter((peer) => peer.id !== peerId) }));

/** The label Cilium gives every endpoint for its namespace, and the one Kubernetes gives every namespace for its name. */
export const namespaceLabelKey = "k8s:io.kubernetes.pod.namespace";
export const namespaceMetadataNameLabel = "kubernetes.io/metadata.name";
