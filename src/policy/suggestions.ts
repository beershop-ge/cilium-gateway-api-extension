import { parseCiliumLabelList } from "../common/selectors";
import type { FlowEdge, FlowEndpoint, FlowFilter } from "../observability/hubble";
import { describePeer } from "./summary";
import { addRule, isNamespacedKind, newId, newPort, newPortRule, newRule, type Peer, type PolicyModel, type Protocol } from "./model";
import { allowKubeDns, type SafetyContext } from "./safety";
import { modelSelectsEndpoint } from "./selection";

export interface Suggestion {
  /** Stable for the same direction and peer. */
  readonly key: string;
  readonly direction: "ingress" | "egress";
  readonly peer: Peer;
  readonly peerLabel: string;
  /** Observed destination ports. Empty when flows had none (ICMP) or the port could not be read. */
  readonly ports: ReadonlyArray<{ readonly port: string; readonly protocol: Protocol }>;
  readonly forwarded: number;
  readonly dropped: number;
  readonly other: number;
  readonly dropReasons: readonly string[];
  readonly lastSeen: string;
  /** The observed endpoints behind this suggestion, by name. */
  readonly observed: readonly string[];
}

/** Labels that change with every rollout or pod and so make poor selectors. */
const volatileLabels = new Set([
  "pod-template-hash",
  "controller-revision-hash",
  "pod-template-generation",
  "statefulset.kubernetes.io/pod-name",
  "apps.kubernetes.io/pod-index",
  "controller-uid",
  "batch.kubernetes.io/controller-uid",
]);

/** Picks labels that identify a workload rather than one pod: the app labels when present, else every stable label. */
export const stableWorkloadLabels = (labels: Readonly<Record<string, string>>): Record<string, string> => {
  const stable = Object.fromEntries(
    Object.entries(labels).filter(([key]) => !volatileLabels.has(key) && !key.startsWith("io.cilium.k8s.") && !key.startsWith("io.kubernetes.pod.") && !key.includes(":")),
  );

  if (stable["app.kubernetes.io/name"] !== undefined) {
    return {
      "app.kubernetes.io/name": stable["app.kubernetes.io/name"],
      ...(stable["app.kubernetes.io/instance"] !== undefined ? { "app.kubernetes.io/instance": stable["app.kubernetes.io/instance"] } : {}),
    };
  }

  for (const key of ["app", "k8s-app", "name"]) {
    if (stable[key] !== undefined) return { [key]: stable[key] };
  }

  return stable;
};

const reservedEntities = ["kube-apiserver", "host", "remote-node", "health", "ingress", "init", "unmanaged", "world"] as const;

const labelsOf = (endpoint: FlowEndpoint) => parseCiliumLabelList(endpoint.labels);

const hostCidr = (ip: string) => (ip.includes(":") ? `${ip}/128` : `${ip}/32`);

/** Whether a flow endpoint is one of the workloads the policy selects. */
export const flowEndpointSelected = (model: PolicyModel, endpoint: FlowEndpoint): boolean => {
  const labels = labelsOf(endpoint);

  if (model.subject === "nodes") {
    return labels["reserved:host"] !== undefined;
  }

  if (!endpoint.namespace) {
    return false;
  }

  return modelSelectsEndpoint(model, { namespace: endpoint.namespace, labels: { "io.kubernetes.pod.namespace": endpoint.namespace, ...labels } });
};

/** The peer a rule needs to allow traffic with this endpoint, or undefined when nothing identifies it. */
export const peerForFlowEndpoint = (model: PolicyModel, endpoint: FlowEndpoint, direction: "ingress" | "egress"): Peer | undefined => {
  const labels = labelsOf(endpoint);
  const cilium = model.kind !== "NetworkPolicy";

  if (endpoint.namespace && !reservedEntities.some((entity) => labels[`reserved:${entity}`] !== undefined)) {
    const podLabels = stableWorkloadLabels(labels);
    const selector = { matchLabels: podLabels, matchExpressions: [] };
    const sameNamespace = isNamespacedKind(model.kind) && endpoint.namespace === model.namespace;

    return sameNamespace
      ? { id: newId("peer"), type: "endpoint", selector }
      : { id: newId("peer"), type: "namespace", namespaceName: endpoint.namespace, podSelector: selector };
  }

  const entity = reservedEntities.find((candidate) => labels[`reserved:${candidate}`] !== undefined);
  const name = endpoint.names?.find((candidate) => candidate.trim() !== "")?.replace(/\.$/, "");

  if (entity === "world" || entity === undefined) {
    if (cilium && direction === "egress" && name) return { id: newId("peer"), type: "fqdn", matchName: name };
    if (endpoint.ip) return { id: newId("peer"), type: "cidr", cidr: hostCidr(endpoint.ip), except: [] };
    if (cilium && entity === "world") return { id: newId("peer"), type: "entity", entities: ["world"] };

    return undefined;
  }

  if (cilium) {
    return { id: newId("peer"), type: "entity", entities: [entity] };
  }

  // NetworkPolicy knows no entities: the best it can do is the address.
  return endpoint.ip ? { id: newId("peer"), type: "cidr", cidr: hostCidr(endpoint.ip), except: [] } : undefined;
};

const peerKey = (peer: Peer) =>
  JSON.stringify([peer.type, peer.selector?.matchLabels, peer.namespaceName, peer.podSelector?.matchLabels, peer.entities, peer.cidr, peer.matchName]);

const parsePort = (text: string): { port: string; protocol: Protocol } | undefined => {
  const [port, protocol] = text.split("/");

  return /^\d+$/.test(port ?? "") && (protocol === "TCP" || protocol === "UDP" || protocol === "SCTP") ? { port, protocol } : undefined;
};

/**
 * Turns observed traffic into rule suggestions for the policy's selected workloads: traffic arriving at them
 * becomes ingress, traffic they send becomes egress, grouped by peer, with ports, counts and verdicts.
 */
export const suggestRules = (model: PolicyModel, edges: readonly FlowEdge[]): Suggestion[] => {
  const groups = new Map<string, { direction: "ingress" | "egress"; peer: Peer; ports: Map<string, { port: string; protocol: Protocol }>; forwarded: number; dropped: number; other: number; dropReasons: Set<string>; lastSeen: string; observed: Set<string> }>();

  const add = (direction: "ingress" | "egress", other: FlowEndpoint, otherName: string, edge: FlowEdge) => {
    const peer = peerForFlowEndpoint(model, other, direction);

    if (!peer) return;

    const key = `${direction}|${peerKey(peer)}`;
    let group = groups.get(key);

    if (!group) {
      group = { direction, peer, ports: new Map(), forwarded: 0, dropped: 0, other: 0, dropReasons: new Set(), lastSeen: edge.lastSeen, observed: new Set() };
      groups.set(key, group);
    }

    for (const port of edge.ports.map(parsePort)) {
      if (port) group.ports.set(`${port.port}/${port.protocol}`, port);
    }

    group.forwarded += edge.forwarded;
    group.dropped += edge.dropped;
    group.other += edge.other;
    for (const reason of edge.dropReasons) group.dropReasons.add(reason);
    if (edge.lastSeen > group.lastSeen) group.lastSeen = edge.lastSeen;
    group.observed.add(otherName);
  };

  for (const edge of edges) {
    if (flowEndpointSelected(model, edge.toEndpoint)) add("ingress", edge.fromEndpoint, edge.from, edge);
    if (flowEndpointSelected(model, edge.fromEndpoint)) add("egress", edge.toEndpoint, edge.to, edge);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      direction: group.direction,
      peer: group.peer,
      peerLabel: describePeer(model, group.peer),
      ports: [...group.ports.values()].sort((a, b) => Number(a.port) - Number(b.port) || a.protocol.localeCompare(b.protocol)),
      forwarded: group.forwarded,
      dropped: group.dropped,
      other: group.other,
      dropReasons: [...group.dropReasons],
      lastSeen: group.lastSeen,
      observed: [...group.observed].sort(),
    }))
    .sort((a, b) => a.direction.localeCompare(b.direction) || b.forwarded + b.dropped - (a.forwarded + a.dropped));
};

/**
 * Adds the picked suggestions as rules, one per suggestion. When an FQDN suggestion is among them, DNS to kube-dns
 * with a DNS rule is allowed too, since FQDN rules only work with it.
 */
export const applySuggestions = (model: PolicyModel, picked: readonly Suggestion[], context: SafetyContext = {}): PolicyModel => {
  let next = model;

  for (const suggestion of picked) {
    const rule = newRule([{ ...suggestion.peer, id: newId("peer") }]);
    const portRules = suggestion.ports.length > 0 ? [newPortRule(suggestion.ports.map((port) => newPort(port.port, port.protocol)))] : [];

    next = addRule(next, suggestion.direction, { ...rule, portRules });
  }

  if (picked.some((suggestion) => suggestion.peer.type === "fqdn")) {
    next = allowKubeDns(next, context);
  }

  return next;
};

/** The Hubble filter that reads the flows of the policy's selected workloads. */
export const flowFilterFor = (model: PolicyModel, { since, last }: { since?: string; last?: number } = {}): FlowFilter => {
  const labels = Object.entries(model.selector.matchLabels).map(([key, value]) => `${key.replace(/^(k8s|any):/, "")}=${value}`);

  return {
    ...(since ? { since } : {}),
    last: last ?? 2000,
    ...(isNamespacedKind(model.kind) && model.namespace ? { namespace: model.namespace } : {}),
    ...(labels.length > 0 ? { labels: labels.join(",") } : {}),
  };
};
