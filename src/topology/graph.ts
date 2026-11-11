import { rangeContains, rangeOfBlock } from "../common/cidr";
import { type Condition, conditionsOf, type Health, healthOf, healthOfResource } from "../common/conditions";
import type { Json } from "../common/json";
import { ciliumLabelsOfPod, describeSelector, type LabelSelector, selectorMatches } from "../common/selectors";
import { routeKinds } from "./kinds";

/** A group of nodes the user can show or hide, and the legend names. */
export type Layer =
  | "internet"
  | "bgp"
  | "lbipam"
  | "l2"
  | "gateway"
  | "listener"
  | "route"
  | "envoy"
  | "service"
  | "endpoint"
  | "pod"
  | "policy"
  | "identity"
  | "egress"
  | "node"
  | "external";

export const layers: ReadonlyArray<{ readonly id: Layer; readonly label: string }> = [
  { id: "internet", label: "Internet" },
  { id: "bgp", label: "BGP" },
  { id: "lbipam", label: "LB IP pools" },
  { id: "l2", label: "L2 announcements" },
  { id: "gateway", label: "Gateways" },
  { id: "listener", label: "Listeners" },
  { id: "route", label: "Routes" },
  { id: "envoy", label: "Envoy configs" },
  { id: "service", label: "Services" },
  { id: "endpoint", label: "Endpoints" },
  { id: "pod", label: "Pods" },
  { id: "policy", label: "Network policies" },
  { id: "identity", label: "Identities" },
  { id: "egress", label: "Egress gateways" },
  { id: "node", label: "Nodes" },
  { id: "external", label: "Observed peers" },
];

/** Columns, left to right: every configured relationship points from a lower column to a higher one. */
export const column = {
  internet: 0,
  bgpCluster: 1,
  bgpPeer: 2,
  bgpPeerConfig: 3,
  edge: 4,
  gateway: 5,
  listener: 6,
  route: 7,
  service: 8,
  endpoint: 9,
  pod: 10,
  podAttached: 11,
  node: 12,
  external: 13,
} as const;

/** What a resource node opens: the shape `resourceActions.openRef` takes. */
export interface NodeRef {
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly group?: string;
}

export interface GraphNode {
  readonly id: string;
  readonly layer: Layer;
  readonly column: number;
  readonly kind: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Unset for cluster-scoped resources. */
  readonly namespace?: string;
  readonly health: Health;
  readonly healthReason?: string;
  readonly ref?: NodeRef;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  readonly conditions: readonly Condition[];
  /** Referenced by another resource but not found in the cluster. */
  readonly missing?: boolean;
}

/** `path` follows traffic (Internet → … → Node); `config` is any other relationship stated in a resource. */
export type Relation = "path" | "config";

export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly relation: Relation;
  readonly label?: string;
  readonly health: Health;
  /** Set when the edge stands for a path through nodes that are hidden by a filter. */
  readonly via?: string;
}

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphInput {
  /** Items by kind (CRDs) or builtin resource name, as `Snapshot.items`. */
  readonly items: Readonly<Record<string, readonly Json[] | undefined>>;
  /** Kinds or builtins that could not be read, so health that depends on them is reported unknown rather than wrong. */
  readonly unavailable?: readonly string[];
}

interface MutableNode {
  id: string;
  layer: Layer;
  column: number;
  kind: string;
  title: string;
  subtitle?: string;
  namespace?: string;
  health: Health;
  healthReason?: string;
  ref?: NodeRef;
  facts: Array<readonly [string, string]>;
  conditions: Condition[];
  missing?: boolean;
}

const key = (namespace: string | undefined, name: string) => (namespace ? `${namespace}/${name}` : name);

export const nodeId = {
  internet: "internet",
  gateway: (namespace: string, name: string) => `gateway:${key(namespace, name)}`,
  listener: (namespace: string, gateway: string, name: string) => `listener:${key(namespace, gateway)}:${name}`,
  route: (kind: string, namespace: string, name: string) => `route:${kind}:${key(namespace, name)}`,
  service: (namespace: string, name: string) => `service:${key(namespace, name)}`,
  backend: (kind: string, namespace: string, name: string) => `backend:${kind}:${key(namespace, name)}`,
  endpoint: (namespace: string, service: string, target: string) => `endpoint:${key(namespace, service)}:${target}`,
  pod: (namespace: string, name: string) => `pod:${key(namespace, name)}`,
  node: (name: string) => `node:${name}`,
  identity: (id: string | number) => `identity:${id}`,
  policy: (kind: string, namespace: string | undefined, name: string) => `policy:${kind}:${key(namespace, name)}`,
  egress: (name: string) => `egress:${name}`,
  bgpCluster: (kind: string, name: string) => `bgp:${kind}:${name}`,
  bgpPeer: (owner: string, instance: string, peer: string) => `bgppeer:${owner}:${instance}:${peer}`,
  bgpPeerConfig: (name: string) => `bgp:CiliumBGPPeerConfig:${name}`,
  bgpAdvertisement: (name: string) => `bgp:CiliumBGPAdvertisement:${name}`,
  pool: (name: string) => `lbpool:${name}`,
  l2: (name: string) => `l2:${name}`,
  envoy: (kind: string, namespace: string | undefined, name: string) => `envoy:${kind}:${key(namespace, name)}`,
};

const list = (input: GraphInput, what: string): Json[] => (input.items[what] ?? []) as Json[];

const join = (values: readonly unknown[], empty = "—") => (values.filter((value) => value !== undefined && value !== "").join(", ") || empty);

const portsOf = (service: Json) =>
  ((service.spec?.ports ?? []) as Json[]).map((port) => `${port.name ? `${port.name} ` : ""}${port.port}${port.targetPort !== undefined && port.targetPort !== port.port ? `→${port.targetPort}` : ""}/${port.protocol ?? "TCP"}`);

const ingressIps = (service: Json): string[] =>
  ((service.status?.loadBalancer?.ingress ?? []) as Json[]).map((ingress) => ingress.ip ?? ingress.hostname).filter((value): value is string => typeof value === "string");

/** Pod health from its phase and containers: crash loops and image pulls fail, unready containers wait. */
export const podHealth = (pod: Json): { health: Health; reason?: string } => {
  const statuses = [...((pod.status?.initContainerStatuses ?? []) as Json[]), ...((pod.status?.containerStatuses ?? []) as Json[])];
  const broken = statuses.find((status) => /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainer\w*Error|InvalidImageName|RunContainerError/.test(status.state?.waiting?.reason ?? ""));
  const phase = pod.status?.phase;

  if (broken) {
    return { health: "error", reason: `${broken.name}: ${broken.state.waiting.reason}${broken.state.waiting.message ? ` — ${broken.state.waiting.message}` : ""}` };
  }

  if (pod.metadata?.deletionTimestamp) {
    return { health: "warn", reason: "Terminating" };
  }

  switch (phase) {
    case "Failed":
      return { health: "error", reason: `Failed${pod.status?.reason ? `: ${pod.status.reason}` : ""}${pod.status?.message ? ` — ${pod.status.message}` : ""}` };
    case "Succeeded":
      return { health: "ok", reason: "Completed" };
    case "Running": {
      const notReady = ((pod.status?.containerStatuses ?? []) as Json[]).filter((status) => !status.ready).map((status) => status.name);

      return notReady.length > 0 ? { health: "warn", reason: `Not ready: ${notReady.join(", ")}` } : { health: "ok" };
    }
    case "Pending": {
      const unscheduled = conditionsOf(pod.status).find((condition) => condition.type === "PodScheduled" && condition.status === "False");

      return { health: "warn", reason: unscheduled ? `Pending: ${unscheduled.reason ?? "not scheduled"}${unscheduled.message ? ` — ${unscheduled.message}` : ""}` : "Pending" };
    }
    default:
      return { health: "unknown", reason: phase ? `Phase ${phase}` : "No status reported" };
  }
};

/** IP pool health: Cilium reports conflicts and exhaustion as conditions that are bad when True. */
const poolHealth = (pool: Json): { health: Health; reason?: string } => {
  if (pool.spec?.disabled) {
    return { health: "warn", reason: "The pool is disabled" };
  }

  const bad = conditionsOf(pool.status).find((condition) => /conflict|exhausted/i.test(condition.type) && condition.status === "True");

  if (bad) {
    return { health: "error", reason: `${bad.type}${bad.message ? ` — ${bad.message}` : ""}` };
  }

  return conditionsOf(pool.status).length > 0 ? { health: "ok" } : { health: "unknown", reason: "No status reported" };
};

/** Policy health: conditions when the Cilium version reports them, else per-node enforcement errors. */
const policyHealth = (policy: Json): { health: Health; reason?: string } => {
  if (conditionsOf(policy.status).length > 0) {
    return healthOfResource(policy);
  }

  const nodes = Object.entries((policy.status?.nodes ?? {}) as Record<string, Json>);
  const failing = nodes.find(([, status]) => status?.error);

  if (failing) {
    return { health: "error", reason: `Node ${failing[0]}: ${failing[1].error}` };
  }

  if (nodes.length > 0) {
    return nodes.every(([, status]) => status?.enforcing !== false) ? { health: "ok" } : { health: "warn", reason: "Not enforced on every node" };
  }

  return { health: "unknown", reason: "No status reported" };
};

const nodeRoles = (node: Json) =>
  Object.keys(node.metadata?.labels ?? {})
    .filter((label) => label.startsWith("node-role.kubernetes.io/"))
    .map((label) => label.slice("node-role.kubernetes.io/".length));

const ruleCounts = (specs: readonly Json[]) => {
  const count = (field: string) => specs.reduce((sum, spec) => sum + ((spec?.[field] ?? []) as Json[]).length, 0);

  return `${count("ingress")} ingress, ${count("egress")} egress${count("ingressDeny") + count("egressDeny") > 0 ? `, ${count("ingressDeny")} ingress deny, ${count("egressDeny")} egress deny` : ""}`;
};

/**
 * Builds the topology from what was read: only relationships stated in the resources (references,
 * owner references, label selectors, addresses inside pool blocks) are drawn, never assumed ones.
 */
export const buildGraph = (input: GraphInput): Graph => {
  const unavailable = new Set(input.unavailable ?? []);
  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, GraphEdge>();

  const addNode = (node: MutableNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);

    return nodes.get(node.id)!;
  };

  const addEdge = (from: string, to: string, relation: Relation, label?: string, health: Health = "ok") => {
    if (!nodes.has(from) || !nodes.has(to) || from === to) return;

    const id = `${from}->${to}`;
    const existing = edges.get(id);
    const labels = [...new Set([...(existing?.label ? existing.label.split(", ") : []), ...(label ? [label] : [])])];
    const rank = { error: 3, warn: 2, unknown: 1, ok: 0 } as const;

    edges.set(id, {
      id,
      from,
      to,
      relation: existing?.relation === "path" ? "path" : relation,
      label: labels.length ? labels.join(", ") : undefined,
      health: existing && rank[existing.health] > rank[health] ? existing.health : health,
    });
  };

  const namespaceLabels = new Map<string, Record<string, string>>(
    list(input, "namespaces").map((namespace) => [namespace.metadata.name, { "kubernetes.io/metadata.name": namespace.metadata.name, ...(namespace.metadata.labels ?? {}) }]),
  );
  const services = list(input, "services");
  const pods = list(input, "pods");
  const kubeNodes = list(input, "nodes");
  const slices = list(input, "endpointslices.discovery.k8s.io");
  const podLabels = new Map(pods.map((pod) => [nodeId.pod(pod.metadata.namespace, pod.metadata.name), ciliumLabelsOfPod(pod, namespaceLabels.get(pod.metadata.namespace))]));

  const ensureInternet = () =>
    addNode({
      id: nodeId.internet,
      layer: "internet",
      column: column.internet,
      kind: "Internet",
      title: "Internet",
      subtitle: "Clients outside the cluster",
      health: "unknown",
      healthReason: "Outside the cluster; shown where a Gateway or LoadBalancer Service has an external address",
      facts: [["Meaning", "Clients reaching addresses the cluster publishes (Gateway and LoadBalancer addresses)"]],
      conditions: [],
    });

  // Nodes
  for (const node of kubeNodes) {
    const conditions = conditionsOf(node.status);
    const health = healthOf(conditions, ["Ready"]);
    const addresses = (node.status?.addresses ?? []) as Json[];

    addNode({
      id: nodeId.node(node.metadata.name),
      layer: "node",
      column: column.node,
      kind: "Node",
      title: node.metadata.name,
      subtitle: join([...nodeRoles(node), addresses.find((address) => address.type === "InternalIP")?.address], ""),
      health: node.spec?.unschedulable && health.health === "ok" ? "warn" : health.health,
      healthReason: node.spec?.unschedulable && health.health === "ok" ? "Cordoned (unschedulable)" : health.reason,
      ref: { kind: "Node", name: node.metadata.name },
      facts: [
        ["Roles", join(nodeRoles(node))],
        ["Addresses", join(addresses.map((address) => `${address.type} ${address.address}`))],
        ["Pod CIDRs", join(node.spec?.podCIDRs ?? [node.spec?.podCIDR])],
        ["Kubelet", node.status?.nodeInfo?.kubeletVersion ?? "—"],
        ["Schedulable", node.spec?.unschedulable ? "No (cordoned)" : "Yes"],
      ],
      conditions,
    });
  }

  // Pods, on their nodes
  for (const pod of pods) {
    const { name, namespace } = pod.metadata;
    const health = podHealth(pod);
    const owner = ((pod.metadata.ownerReferences ?? []) as Json[])[0];
    const restarts = ((pod.status?.containerStatuses ?? []) as Json[]).reduce((sum, status) => sum + (status.restartCount ?? 0), 0);
    const id = addNode({
      id: nodeId.pod(namespace, name),
      layer: "pod",
      column: column.pod,
      kind: "Pod",
      title: name,
      subtitle: join([namespace, pod.status?.podIP], ""),
      namespace,
      health: health.health,
      healthReason: health.reason,
      ref: { kind: "Pod", name, namespace },
      facts: [
        ["Namespace", namespace],
        ["Phase", pod.status?.phase ?? "—"],
        ["Pod IPs", join(((pod.status?.podIPs ?? []) as Json[]).map((ip) => ip.ip).concat(pod.status?.podIPs ? [] : [pod.status?.podIP]))],
        ["Node", pod.spec?.nodeName ?? "not scheduled"],
        ["Owner", owner ? `${owner.kind} ${owner.name}` : "—"],
        ["Service account", pod.spec?.serviceAccountName ?? "default"],
        ["Restarts", String(restarts)],
        ...(pod.spec?.hostNetwork ? [["Host network", "Yes (not managed as a Cilium endpoint)"] as const] : []),
      ],
      conditions: conditionsOf(pod.status),
    }).id;

    if (pod.spec?.nodeName) addEdge(id, nodeId.node(pod.spec.nodeName), "path", "runs on");
  }

  // Cilium endpoints and their security identities
  const identities = new Map(list(input, "CiliumIdentity").map((identity) => [String(identity.metadata.name), identity]));

  for (const endpoint of list(input, "CiliumEndpoint")) {
    const pod = nodes.get(nodeId.pod(endpoint.metadata.namespace, endpoint.metadata.name));
    const identity = endpoint.status?.identity;
    const state = endpoint.status?.state;

    if (pod) {
      pod.facts.push(["Cilium endpoint", `${endpoint.status?.id ?? "?"} (${state ?? "no state"})`]);

      if (state && state !== "ready" && pod.health === "ok") {
        pod.health = state === "invalid" || state === "disconnected" ? "error" : "warn";
        pod.healthReason = `Cilium endpoint state: ${state}`;
      }

      const policyEnabled = endpoint.status?.policy;

      if (policyEnabled) {
        pod.facts.push(["Policy enforcement", `ingress ${policyEnabled.ingress?.state ?? policyEnabled.ingress?.enforcing ?? "?"}, egress ${policyEnabled.egress?.state ?? policyEnabled.egress?.enforcing ?? "?"}`]);
      }
    }

    if (!pod || identity?.id === undefined) continue;

    const resource = identities.get(String(identity.id));
    const labels = (identity.labels ?? (resource ? Object.entries(resource["security-labels"] ?? {}).map(([label, value]) => `${label}=${value}`) : [])) as string[];
    const shortLabels = labels.filter((label) => !label.includes("io.cilium.k8s") && !label.includes("io.kubernetes.pod.namespace"));
    const identityKnown = resource !== undefined;
    const identityNode = addNode({
      id: nodeId.identity(identity.id),
      layer: "identity",
      column: column.podAttached,
      kind: "Identity",
      title: `Identity ${identity.id}`,
      subtitle: shortLabels.slice(0, 2).join(" ") || undefined,
      health: identityKnown || unavailable.has("CiliumIdentity") ? "unknown" : Number(identity.id) < 256 ? "unknown" : "warn",
      healthReason: identityKnown
        ? undefined
        : unavailable.has("CiliumIdentity")
          ? "CiliumIdentity could not be read"
          : Number(identity.id) < 256
            ? "Reserved identity (no CiliumIdentity resource)"
            : "No CiliumIdentity resource with this id (identities may be allocated in a kvstore)",
      ref: identityKnown ? { kind: "CiliumIdentity", name: String(identity.id), group: "cilium.io" } : undefined,
      facts: [
        ["Numeric id", String(identity.id)],
        ["Labels", join(labels)],
      ],
      conditions: [],
    });

    addEdge(pod.id, identityNode.id, "config", "identity");
  }

  // Services, their endpoints, and the pods behind them
  const serviceIdOf = (service: Json) => nodeId.service(service.metadata.namespace, service.metadata.name);
  const gatewayOfService = (service: Json): string | undefined =>
    service.metadata.labels?.["gateway.networking.k8s.io/gateway-name"] ?? service.metadata.labels?.["io.cilium.gateway/owning-gateway"];

  for (const service of services) {
    const { name, namespace } = service.metadata;
    const type = service.spec?.type ?? "ClusterIP";

    addNode({
      id: serviceIdOf(service),
      layer: "service",
      column: column.service,
      kind: "Service",
      title: name,
      subtitle: join([namespace, type, ...(type === "LoadBalancer" ? ingressIps(service) : [])], ""),
      namespace,
      health: "unknown",
      ref: { kind: "Service", name, namespace },
      facts: [
        ["Namespace", namespace],
        ["Type", type],
        ["Cluster IPs", join(service.spec?.clusterIPs ?? [service.spec?.clusterIP])],
        ["Ports", join(portsOf(service))],
        ...(service.spec?.externalIPs?.length ? [["External IPs", join(service.spec.externalIPs)] as const] : []),
        ...(type === "LoadBalancer" ? [["LoadBalancer address", join(ingressIps(service), "pending")] as const] : []),
        ...(service.spec?.loadBalancerClass ? [["LoadBalancer class", String(service.spec.loadBalancerClass)] as const] : []),
        ...(type === "ExternalName" ? [["External name", String(service.spec?.externalName ?? "—")] as const] : []),
        ["Selector", service.spec?.selector ? describeSelector({ matchLabels: service.spec.selector }) : "none"],
      ],
      conditions: conditionsOf(service.status),
    });
  }

  const endpointCounts = new Map<string, { ready: number; total: number }>();

  for (const slice of slices) {
    const serviceName = slice.metadata.labels?.["kubernetes.io/service-name"];
    const namespace = slice.metadata.namespace;
    const service = serviceName ? nodes.get(nodeId.service(namespace, serviceName)) : undefined;

    if (!service || !serviceName) continue;

    const ports = ((slice.ports ?? []) as Json[]).map((port) => `${port.name ? `${port.name} ` : ""}${port.port}/${port.protocol ?? "TCP"}`);

    for (const endpoint of (slice.endpoints ?? []) as Json[]) {
      const target = endpoint.targetRef?.name ? `${endpoint.targetRef.kind ?? "Pod"}/${endpoint.targetRef.name}` : String(endpoint.addresses?.[0] ?? "unknown");
      const id = nodeId.endpoint(namespace, serviceName, target);
      const existing = nodes.get(id);
      const ready = endpoint.conditions?.ready !== false;
      const terminating = endpoint.conditions?.terminating === true;
      const addresses = (endpoint.addresses ?? []) as string[];

      if (existing) {
        // The same backend in an IPv4 and an IPv6 slice.
        const index = existing.facts.findIndex(([label]) => label === "Addresses");

        if (index >= 0) existing.facts[index] = ["Addresses", join([...new Set([...existing.facts[index][1].split(", "), ...addresses])])];

        continue;
      }

      const counts = endpointCounts.get(service.id) ?? { ready: 0, total: 0 };

      endpointCounts.set(service.id, { ready: counts.ready + (ready ? 1 : 0), total: counts.total + 1 });

      addNode({
        id,
        layer: "endpoint",
        column: column.endpoint,
        kind: "Endpoint",
        title: join(addresses, target),
        subtitle: join([namespace, endpoint.targetRef?.name ? target : undefined, endpoint.nodeName], ""),
        namespace,
        health: terminating ? "warn" : ready ? "ok" : "warn",
        healthReason: terminating ? "Terminating" : ready ? undefined : "Not ready",
        ref: { kind: "EndpointSlice", name: slice.metadata.name, namespace, group: "discovery.k8s.io" },
        facts: [
          ["Service", key(namespace, serviceName)],
          ["EndpointSlice", slice.metadata.name],
          ["Addresses", join(addresses)],
          ["Target", endpoint.targetRef ? `${endpoint.targetRef.kind} ${endpoint.targetRef.name}` : "none"],
          ["Node", endpoint.nodeName ?? "—"],
          ["Zone", endpoint.zone ?? "—"],
          ["Ready", ready ? "Yes" : "No"],
          ["Serving", endpoint.conditions?.serving === false ? "No" : "Yes"],
          ["Ports", join(ports)],
        ],
        conditions: [],
      });

      addEdge(service.id, id, "path", ports.join(", ") || undefined, ready ? "ok" : "warn");

      if (endpoint.targetRef?.kind === "Pod") {
        const podId = nodeId.pod(endpoint.targetRef.namespace ?? namespace, endpoint.targetRef.name);

        if (nodes.has(podId)) {
          addEdge(id, podId, "path", undefined, ready ? "ok" : "warn");
        } else {
          nodes.get(id)!.facts.push(["Pod", unavailable.has("pods") ? "pods could not be read" : "not found"]);
        }
      }
    }
  }

  for (const service of services) {
    const node = nodes.get(serviceIdOf(service))!;
    const type = service.spec?.type ?? "ClusterIP";
    const counts = endpointCounts.get(node.id) ?? { ready: 0, total: 0 };

    node.facts.push(["Endpoints ready", `${counts.ready} of ${counts.total}`]);

    if (type === "ExternalName") {
      node.health = "unknown";
      node.healthReason = "ExternalName Service: resolved by DNS, no endpoints";
    } else if (unavailable.has("endpointslices.discovery.k8s.io")) {
      node.health = "unknown";
      node.healthReason = "EndpointSlices could not be read";
    } else if (counts.total === 0) {
      node.health = service.spec?.selector ? "warn" : "unknown";
      node.healthReason = service.spec?.selector ? "No endpoints: no ready pod matches the selector" : "No selector and no EndpointSlices";
    } else if (counts.ready === 0) {
      node.health = "error";
      node.healthReason = "No ready endpoints";
    } else if (counts.ready < counts.total) {
      node.health = "warn";
      node.healthReason = `${counts.ready} of ${counts.total} endpoints ready`;
    } else {
      node.health = "ok";
    }

    if (type === "LoadBalancer" && ingressIps(service).length === 0 && node.health !== "error") {
      node.health = "warn";
      node.healthReason = "No LoadBalancer address assigned yet";
    }
  }

  const missingService = (namespace: string, name: string, referrer: string) =>
    addNode({
      id: nodeId.service(namespace, name),
      layer: "service",
      column: column.service,
      kind: "Service",
      title: name,
      subtitle: `${namespace} · not found`,
      namespace,
      health: unavailable.has("services") ? "unknown" : "error",
      healthReason: unavailable.has("services") ? "Services could not be read" : `Referenced by ${referrer} but not found`,
      facts: [["Namespace", namespace], ["Referenced by", referrer]],
      conditions: [],
      missing: true,
    });

  // Gateways and their listeners
  const listenersOf = new Map<string, Array<{ id: string; name: string; port?: number }>>();
  const gateways = list(input, "Gateway");

  for (const gateway of gateways) {
    const { name, namespace } = gateway.metadata;
    const conditions = conditionsOf(gateway.status);
    const health = healthOf(conditions, ["Accepted", "Programmed"]);
    const addresses = ((gateway.status?.addresses ?? []) as Json[]).map((address) => String(address.value));
    const id = addNode({
      id: nodeId.gateway(namespace, name),
      layer: "gateway",
      column: column.gateway,
      kind: "Gateway",
      title: name,
      subtitle: join([namespace, ...addresses], ""),
      namespace,
      health: health.health,
      healthReason: health.reason,
      ref: { kind: "Gateway", name, namespace, group: "gateway.networking.k8s.io" },
      facts: [
        ["Namespace", namespace],
        ["Class", gateway.spec?.gatewayClassName ?? "—"],
        ["Addresses", join(addresses, "none assigned")],
        ["Listeners", String(gateway.spec?.listeners?.length ?? 0)],
      ],
      conditions,
    }).id;

    if (addresses.length > 0) {
      ensureInternet();
      addEdge(nodeId.internet, id, "path", addresses.join(", "), health.health === "error" ? "error" : "ok");
    }

    const statuses = (gateway.status?.listeners ?? []) as Json[];

    for (const listener of (gateway.spec?.listeners ?? []) as Json[]) {
      const status = statuses.find((candidate) => candidate.name === listener.name);
      const listenerConditions = conditionsOf(status);
      const listenerHealth = status ? healthOf(listenerConditions, ["Accepted", "Programmed", "ResolvedRefs"]) : { health: "unknown" as Health, reason: "No listener status reported" };
      const listenerId = addNode({
        id: nodeId.listener(namespace, name, listener.name),
        layer: "listener",
        column: column.listener,
        kind: "Listener",
        title: `${listener.name}`,
        subtitle: `${listener.protocol} :${listener.port}${listener.hostname ? ` · ${listener.hostname}` : ""}`,
        namespace,
        health: listenerHealth.health,
        healthReason: listenerHealth.reason,
        ref: { kind: "Gateway", name, namespace, group: "gateway.networking.k8s.io" },
        facts: [
          ["Gateway", key(namespace, name)],
          ["Protocol", String(listener.protocol)],
          ["Port", String(listener.port)],
          ["Hostname", listener.hostname ?? "any"],
          ["Routes from", listener.allowedRoutes?.namespaces?.from ?? "Same"],
          ["Attached routes", String(status?.attachedRoutes ?? "—")],
          ...((listener.tls?.certificateRefs ?? []) as Json[]).map((certificate) => ["TLS certificate", `${certificate.kind ?? "Secret"} ${key(certificate.namespace ?? namespace, certificate.name)}`] as const),
        ],
        conditions: listenerConditions,
      }).id;

      listenersOf.set(id, [...(listenersOf.get(id) ?? []), { id: listenerId, name: listener.name, port: listener.port }]);
      addEdge(id, listenerId, "path", undefined, listenerHealth.health === "error" ? "error" : "ok");
    }

    for (const service of services) {
      if (service.metadata.namespace === namespace && gatewayOfService(service) === name) {
        addEdge(id, serviceIdOf(service), "config", "LoadBalancer Service");
      }
    }
  }

  // Routes: attached to listeners by parentRefs, to backends by backendRefs
  for (const kind of routeKinds) {
    for (const route of list(input, kind)) {
      const { name, namespace } = route.metadata;
      const parentStatuses = (route.status?.parents ?? []) as Json[];
      const conditions = parentStatuses.flatMap((status) =>
        conditionsOf(status).map((condition) => ({ ...condition, type: `${condition.type} (${status.parentRef?.name ?? "parent"}${status.parentRef?.sectionName ? `#${status.parentRef.sectionName}` : ""})` })),
      );
      const plain = parentStatuses.flatMap((status) => conditionsOf(status));
      const health = plain.length > 0 ? healthOf(plain, ["Accepted", "ResolvedRefs"]) : { health: "unknown" as Health, reason: "No parent has reported status" };
      const hostnames = (route.spec?.hostnames ?? []) as string[];
      const id = addNode({
        id: nodeId.route(kind, namespace, name),
        layer: "route",
        column: column.route,
        kind,
        title: name,
        subtitle: join([namespace, ...hostnames], ""),
        namespace,
        health: health.health,
        healthReason: health.reason,
        ref: { kind, name, namespace, group: "gateway.networking.k8s.io" },
        facts: [
          ["Namespace", namespace],
          ["Hostnames", join(hostnames, "any")],
          ["Parents", join(((route.spec?.parentRefs ?? []) as Json[]).map((parent) => `${parent.kind ?? "Gateway"} ${key(parent.namespace ?? namespace, parent.name)}${parent.sectionName ? `#${parent.sectionName}` : ""}`))],
          ["Rules", String(route.spec?.rules?.length ?? 0)],
        ],
        conditions,
      }).id;

      for (const parent of (route.spec?.parentRefs ?? []) as Json[]) {
        if ((parent.kind ?? "Gateway") !== "Gateway") continue;

        const gatewayId = nodeId.gateway(parent.namespace ?? namespace, parent.name);
        const status = parentStatuses.find((candidate) => candidate.parentRef?.name === parent.name && (candidate.parentRef?.sectionName ?? "") === (parent.sectionName ?? ""));
        const statusConditions = conditionsOf(status);
        const edgeHealth: Health = !status ? "warn" : healthOf(statusConditions, ["Accepted", "ResolvedRefs"]).health === "ok" ? "ok" : "error";
        const listeners = (listenersOf.get(gatewayId) ?? []).filter((listener) => (!parent.sectionName || listener.name === parent.sectionName) && (!parent.port || listener.port === parent.port));

        if (!nodes.has(gatewayId)) {
          nodes.get(id)!.facts.push(["Parent not found", `Gateway ${key(parent.namespace ?? namespace, parent.name)}`]);
        }

        for (const listener of listeners) addEdge(listener.id, id, "path", undefined, edgeHealth);
      }

      for (const rule of (route.spec?.rules ?? []) as Json[]) {
        for (const backend of (rule.backendRefs ?? []) as Json[]) {
          const backendKind = backend.kind ?? "Service";
          const backendNamespace = backend.namespace ?? namespace;
          const label = backend.port ? `:${backend.port}${backend.weight !== undefined && (rule.backendRefs?.length ?? 0) > 1 ? ` w${backend.weight}` : ""}` : undefined;

          if (backendKind === "Service" && (backend.group ?? "") === "") {
            const serviceId = nodeId.service(backendNamespace, backend.name);

            if (!nodes.has(serviceId)) missingService(backendNamespace, backend.name, `${kind} ${key(namespace, name)}`);
            addEdge(id, serviceId, "path", label, nodes.get(serviceId)!.health === "error" ? "error" : "ok");
          } else {
            const backendId = addNode({
              id: nodeId.backend(backendKind, backendNamespace, backend.name),
              layer: "service",
              column: column.service,
              kind: backendKind,
              title: backend.name,
              subtitle: backendNamespace,
              namespace: backendNamespace,
              health: "unknown",
              healthReason: `A ${backendKind} backend; its state is not read by this view`,
              ref: { kind: backendKind, name: backend.name, namespace: backendNamespace, group: backend.group },
              facts: [["Kind", backendKind], ["Group", backend.group ?? "—"], ["Namespace", backendNamespace]],
              conditions: [],
            }).id;

            addEdge(id, backendId, "path", label, "unknown");
          }
        }
      }
    }
  }

  // Envoy configurations: owned by Gateways, redirecting Services
  const envoyKinds = [
    ["CiliumEnvoyConfig", true],
    ["CiliumClusterwideEnvoyConfig", false],
  ] as const;

  for (const [kind, namespaced] of envoyKinds) {
    for (const config of list(input, kind)) {
      const { name } = config.metadata;
      const namespace = namespaced ? config.metadata.namespace : undefined;
      const health = healthOfResource(config);
      const refs = (field: string) => ((config.spec?.[field] ?? []) as Json[]).filter((service) => service?.name);
      const id = addNode({
        id: nodeId.envoy(kind, namespace, name),
        layer: "envoy",
        column: column.route,
        kind,
        title: name,
        subtitle: join([namespace, `${config.spec?.resources?.length ?? 0} Envoy resources`], ""),
        namespace,
        health: health.health,
        healthReason: health.reason,
        ref: { kind, name, namespace, group: "cilium.io" },
        facts: [
          ...(namespace ? [["Namespace", namespace] as const] : []),
          ["Redirected services", join(refs("services").map((service) => `${key(service.namespace ?? namespace, service.name)}${service.listener ? ` → ${service.listener}` : ""}`))],
          ["Backend services", join(refs("backendServices").map((service) => key(service.namespace ?? namespace, service.name)))],
          ["Envoy resources", String(config.spec?.resources?.length ?? 0)],
          ...(config.spec?.nodeSelector ? [["Node selector", describeSelector(config.spec.nodeSelector)] as const] : []),
        ],
        conditions: conditionsOf(config.status),
      }).id;

      for (const [field, label] of [["services", "redirects"], ["backendServices", "backend"]] as const) {
        for (const service of refs(field)) {
          const serviceNamespace = service.namespace ?? namespace;

          if (!serviceNamespace) continue;
          if (!nodes.has(nodeId.service(serviceNamespace, service.name))) missingService(serviceNamespace, service.name, `${kind} ${key(namespace, name)}`);
          addEdge(id, nodeId.service(serviceNamespace, service.name), "config", label);
        }
      }

      for (const owner of (config.metadata.ownerReferences ?? []) as Json[]) {
        if (owner.kind === "Gateway" && namespace) addEdge(nodeId.gateway(namespace, owner.name), id, "config", "generated");
      }
    }
  }

  // Internet → LoadBalancer Services with an address (Gateways' own Services are reached through the Gateway)
  for (const service of services) {
    if ((service.spec?.type ?? "") === "LoadBalancer" && ingressIps(service).length > 0 && !gatewayOfService(service)) {
      ensureInternet();
      addEdge(nodeId.internet, serviceIdOf(service), "path", ingressIps(service).join(", "));
    }
  }

  // LoadBalancer IP pools → the Services whose addresses lie in their blocks
  for (const pool of list(input, "CiliumLoadBalancerIPPool")) {
    const name = pool.metadata.name;
    const blocks = (pool.spec?.blocks ?? pool.spec?.cidrs ?? []) as Json[];
    const ranges = blocks.map(rangeOfBlock).filter((range) => range !== undefined);
    const health = poolHealth(pool);
    const id = addNode({
      id: nodeId.pool(name),
      layer: "lbipam",
      column: column.edge,
      kind: "CiliumLoadBalancerIPPool",
      title: name,
      subtitle: join(ranges.map((range) => range.label), "no blocks"),
      health: health.health,
      healthReason: health.reason,
      ref: { kind: "CiliumLoadBalancerIPPool", name, group: "cilium.io" },
      facts: [
        ["Blocks", join(ranges.map((range) => range.label))],
        ["Service selector", describeSelector(pool.spec?.serviceSelector)],
        ["Disabled", pool.spec?.disabled ? "Yes" : "No"],
      ],
      conditions: conditionsOf(pool.status),
    }).id;

    for (const service of services) {
      const inPool = ingressIps(service).filter((ip) => ranges.some((range) => rangeContains(range, ip)));

      if (inPool.length > 0) addEdge(id, serviceIdOf(service), "config", inPool.join(", "));
    }
  }

  // L2 announcement policies → the Services they select and can announce
  for (const policy of list(input, "CiliumL2AnnouncementPolicy")) {
    const name = policy.metadata.name;
    const health = healthOfResource(policy);
    const id = addNode({
      id: nodeId.l2(name),
      layer: "l2",
      column: column.edge,
      kind: "CiliumL2AnnouncementPolicy",
      title: name,
      subtitle: join([policy.spec?.loadBalancerIPs ? "LB IPs" : undefined, policy.spec?.externalIPs ? "external IPs" : undefined], "announces nothing"),
      health: health.health,
      healthReason: health.reason,
      ref: { kind: "CiliumL2AnnouncementPolicy", name, group: "cilium.io" },
      facts: [
        ["Service selector", describeSelector(policy.spec?.serviceSelector)],
        ["Node selector", describeSelector(policy.spec?.nodeSelector)],
        ["Interfaces", join(policy.spec?.interfaces ?? [], "all")],
        ["LoadBalancer IPs", policy.spec?.loadBalancerIPs ? "Yes" : "No"],
        ["External IPs", policy.spec?.externalIPs ? "Yes" : "No"],
      ],
      conditions: conditionsOf(policy.status),
    }).id;

    for (const service of services) {
      const announced = [
        ...(policy.spec?.loadBalancerIPs ? ingressIps(service) : []),
        ...(policy.spec?.externalIPs ? ((service.spec?.externalIPs ?? []) as string[]) : []),
      ];

      if (announced.length > 0 && selectorMatches(policy.spec?.serviceSelector, { ...(service.metadata.labels ?? {}), "io.kubernetes.service.namespace": service.metadata.namespace })) {
        addEdge(id, serviceIdOf(service), "config", `announces ${announced.join(", ")}`);
      }
    }
  }

  // BGP control plane v2
  const nodeConfigs = list(input, "CiliumBGPNodeConfig");
  const peerStates = (instance: string, peer: string) =>
    nodeConfigs.flatMap((config) =>
      ((config.status?.bgpInstances ?? []) as Json[])
        .filter((candidate) => candidate.name === instance)
        .flatMap((candidate) => ((candidate.peers ?? []) as Json[]).filter((status) => status.name === peer).map((status) => ({ node: config.metadata.name as string, state: String(status.peeringState ?? "unknown") }))),
    );
  const nodesMatching = (selector: LabelSelector | undefined) => kubeNodes.filter((node) => selectorMatches(selector, node.metadata.labels ?? {}));
  const advertisements = list(input, "CiliumBGPAdvertisement");

  const advertisedServices = (selector: LabelSelector | undefined, addressTypes: readonly string[] | undefined) =>
    selector === undefined
      ? []
      : services.filter((service) => {
          const types = addressTypes?.length ? addressTypes : ["ClusterIP", "ExternalIP", "LoadBalancerIP"];
          const applicable =
            (types.includes("ClusterIP") && service.spec?.clusterIP && service.spec.clusterIP !== "None") ||
            (types.includes("ExternalIP") && (service.spec?.externalIPs ?? []).length > 0) ||
            (types.includes("LoadBalancerIP") && service.spec?.type === "LoadBalancer");

          return applicable && selectorMatches(selector, { ...(service.metadata.labels ?? {}), "io.kubernetes.service.namespace": service.metadata.namespace, "io.kubernetes.service.name": service.metadata.name });
        });

  for (const advertisement of advertisements) {
    const name = advertisement.metadata.name;
    const entries = (advertisement.spec?.advertisements ?? []) as Json[];
    const id = addNode({
      id: nodeId.bgpAdvertisement(name),
      layer: "bgp",
      column: column.edge,
      kind: "CiliumBGPAdvertisement",
      title: name,
      subtitle: join(entries.map((entry) => entry.advertisementType)),
      health: "unknown",
      healthReason: "Advertisements report no status of their own",
      ref: { kind: "CiliumBGPAdvertisement", name, group: "cilium.io" },
      facts: entries.map((entry) => [
        String(entry.advertisementType),
        entry.advertisementType === "Service"
          ? `${join(entry.service?.addresses ?? [], "all addresses")} of services matching ${entry.selector ? describeSelector(entry.selector) : "none (no selector)"}`
          : entry.selector
            ? describeSelector(entry.selector)
            : "—",
      ] as const),
      conditions: [],
    }).id;

    for (const entry of entries) {
      if (entry.advertisementType !== "Service") continue;

      for (const service of advertisedServices(entry.selector, entry.service?.addresses)) {
        addEdge(id, serviceIdOf(service), "config", `advertises ${join(entry.service?.addresses ?? [], "addresses")}`);
      }
    }
  }

  for (const peerConfig of list(input, "CiliumBGPPeerConfig")) {
    const name = peerConfig.metadata.name;
    const health = healthOfResource(peerConfig);
    const families = (peerConfig.spec?.families ?? []) as Json[];
    const id = addNode({
      id: nodeId.bgpPeerConfig(name),
      layer: "bgp",
      column: column.bgpPeerConfig,
      kind: "CiliumBGPPeerConfig",
      title: name,
      subtitle: join(families.map((family) => `${family.afi}/${family.safi}`)),
      health: health.health,
      healthReason: health.reason,
      ref: { kind: "CiliumBGPPeerConfig", name, group: "cilium.io" },
      facts: [
        ["Families", join(families.map((family) => `${family.afi}/${family.safi}: advertisements ${describeSelector(family.advertisements)}`))],
        ["Auth secret", peerConfig.spec?.authSecretRef ?? "none"],
        ["eBGP multihop", String(peerConfig.spec?.ebgpMultihop ?? "—")],
      ],
      conditions: conditionsOf(peerConfig.status),
    }).id;

    for (const family of families) {
      if (!family.advertisements) continue;

      for (const advertisement of advertisements) {
        if (selectorMatches(family.advertisements, advertisement.metadata.labels ?? {})) {
          addEdge(id, nodeId.bgpAdvertisement(advertisement.metadata.name), "config", `${family.afi}/${family.safi}`);
        }
      }
    }
  }

  for (const clusterConfig of list(input, "CiliumBGPClusterConfig")) {
    const name = clusterConfig.metadata.name;
    const health = healthOfResource(clusterConfig);
    const instances = (clusterConfig.spec?.bgpInstances ?? []) as Json[];
    const id = addNode({
      id: nodeId.bgpCluster("CiliumBGPClusterConfig", name),
      layer: "bgp",
      column: column.bgpCluster,
      kind: "CiliumBGPClusterConfig",
      title: name,
      subtitle: join(instances.map((instance) => `${instance.name} AS${instance.localASN ?? "?"}`)),
      health: health.health,
      healthReason: health.reason,
      ref: { kind: "CiliumBGPClusterConfig", name, group: "cilium.io" },
      facts: [
        ["Node selector", describeSelector(clusterConfig.spec?.nodeSelector)],
        ["Instances", join(instances.map((instance) => `${instance.name} (AS ${instance.localASN ?? "?"}, ${instance.peers?.length ?? 0} peers)`))],
      ],
      conditions: conditionsOf(clusterConfig.status),
    }).id;

    for (const node of nodesMatching(clusterConfig.spec?.nodeSelector)) addEdge(id, nodeId.node(node.metadata.name), "config", "BGP on");

    for (const instance of instances) {
      for (const peer of (instance.peers ?? []) as Json[]) {
        const states = peerStates(instance.name, peer.name);
        const down = states.filter((state) => state.state !== "established");
        const peerId = addNode({
          id: nodeId.bgpPeer(name, instance.name, peer.name),
          layer: "bgp",
          column: column.bgpPeer,
          kind: "BGP peer",
          title: peer.name,
          subtitle: join([peer.peerAddress, peer.peerASN !== undefined ? `AS${peer.peerASN}` : undefined], ""),
          health: unavailable.has("CiliumBGPNodeConfig") || states.length === 0 ? "unknown" : down.length === 0 ? "ok" : down.length === states.length ? "error" : "warn",
          healthReason:
            states.length === 0
              ? unavailable.has("CiliumBGPNodeConfig")
                ? "CiliumBGPNodeConfig could not be read"
                : "No session state reported in CiliumBGPNodeConfig"
              : down.length > 0
                ? down.map((state) => `${state.node}: ${state.state}`).join(", ")
                : undefined,
          ref: { kind: "CiliumBGPClusterConfig", name, group: "cilium.io" },
          facts: [
            ["Cluster config", name],
            ["Instance", `${instance.name} (local AS ${instance.localASN ?? "?"})`],
            ["Peer address", peer.peerAddress ?? "auto-discovered"],
            ["Peer AS", String(peer.peerASN ?? "—")],
            ["Peer config", peer.peerConfigRef?.name ?? "—"],
            ["Sessions", join(states.map((state) => `${state.node}: ${state.state}`), "no status")],
          ],
          conditions: [],
        }).id;

        addEdge(id, peerId, "config", instance.name);

        if (peer.peerConfigRef?.name) {
          const configId = nodeId.bgpPeerConfig(peer.peerConfigRef.name);

          if (!nodes.has(configId)) {
            addNode({
              id: configId,
              layer: "bgp",
              column: column.bgpPeerConfig,
              kind: "CiliumBGPPeerConfig",
              title: peer.peerConfigRef.name,
              subtitle: "not found",
              health: unavailable.has("CiliumBGPPeerConfig") ? "unknown" : "error",
              healthReason: unavailable.has("CiliumBGPPeerConfig") ? "CiliumBGPPeerConfig could not be read" : `Referenced by peer ${peer.name} of ${name} but not found`,
              facts: [["Referenced by", `${name} / ${peer.name}`]],
              conditions: [],
              missing: true,
            });
          }

          addEdge(peerId, configId, "config", "peer config");
        }
      }
    }
  }

  // Legacy BGP control plane v1
  for (const policy of list(input, "CiliumBGPPeeringPolicy")) {
    const name = policy.metadata.name;
    const routers = (policy.spec?.virtualRouters ?? []) as Json[];
    const id = addNode({
      id: nodeId.bgpCluster("CiliumBGPPeeringPolicy", name),
      layer: "bgp",
      column: column.bgpCluster,
      kind: "CiliumBGPPeeringPolicy",
      title: name,
      subtitle: join(routers.map((router) => `AS${router.localASN}`)),
      health: "unknown",
      healthReason: "Legacy BGP peering policies report no status",
      ref: { kind: "CiliumBGPPeeringPolicy", name, group: "cilium.io" },
      facts: [
        ["Node selector", describeSelector(policy.spec?.nodeSelector)],
        ["Virtual routers", join(routers.map((router) => `AS ${router.localASN}: ${router.neighbors?.length ?? 0} neighbors, services ${router.serviceSelector ? describeSelector(router.serviceSelector) : "none"}`))],
      ],
      conditions: [],
    }).id;

    for (const node of nodesMatching(policy.spec?.nodeSelector)) addEdge(id, nodeId.node(node.metadata.name), "config", "BGP on");

    for (const router of routers) {
      for (const neighbor of (router.neighbors ?? []) as Json[]) {
        const peerId = addNode({
          id: nodeId.bgpPeer(`policy-${name}`, String(router.localASN), String(neighbor.peerAddress)),
          layer: "bgp",
          column: column.bgpPeer,
          kind: "BGP peer",
          title: String(neighbor.peerAddress),
          subtitle: `AS${neighbor.peerASN}`,
          health: "unknown",
          healthReason: "Session state is not reported by the legacy control plane resources",
          ref: { kind: "CiliumBGPPeeringPolicy", name, group: "cilium.io" },
          facts: [
            ["Peering policy", name],
            ["Local AS", String(router.localASN)],
            ["Peer address", String(neighbor.peerAddress)],
            ["Peer AS", String(neighbor.peerASN)],
          ],
          conditions: [],
        }).id;

        addEdge(id, peerId, "config", `AS${router.localASN}`);
      }

      for (const service of advertisedServices(router.serviceSelector, undefined)) {
        addEdge(id, serviceIdOf(service), "config", `advertises (AS${router.localASN})`);
      }
    }
  }

  // Network policies → selected pods (and, for host policies, nodes). Edges go pod → policy, so every edge points right.
  const policyNode = (kind: string, policy: Json, namespace: string | undefined, facts: Array<readonly [string, string]>) => {
    const health = policyHealth(policy);

    return addNode({
      id: nodeId.policy(kind, namespace, policy.metadata.name),
      layer: "policy",
      column: column.podAttached,
      kind,
      title: policy.metadata.name,
      subtitle: namespace ?? "cluster-wide",
      namespace,
      health: health.health,
      healthReason: health.reason,
      ref: { kind, name: policy.metadata.name, namespace, group: kind === "NetworkPolicy" ? "networking.k8s.io" : "cilium.io" },
      facts: [...(namespace ? [["Namespace", namespace] as const] : []), ...facts],
      conditions: conditionsOf(policy.status),
    });
  };

  const linkPods = (policyId: string, matches: (pod: Json, labels: Record<string, string>) => boolean) => {
    let count = 0;

    for (const pod of pods) {
      const id = nodeId.pod(pod.metadata.namespace, pod.metadata.name);

      if (pod.spec?.hostNetwork) continue;
      if (matches(pod, podLabels.get(id) ?? {})) {
        addEdge(id, policyId, "config", "selected by");
        count++;
      }
    }

    nodes.get(policyId)!.facts.push(["Selected pods", unavailable.has("pods") ? "pods could not be read" : String(count)]);
  };

  for (const [kind, namespaced] of [["CiliumNetworkPolicy", true], ["CiliumClusterwideNetworkPolicy", false]] as const) {
    for (const policy of list(input, kind)) {
      const namespace = namespaced ? policy.metadata.namespace : undefined;
      const specs = [policy.spec, ...((policy.specs ?? []) as Json[])].filter(Boolean);
      const endpointSelectors = specs.map((spec) => spec.endpointSelector).filter(Boolean) as LabelSelector[];
      const nodeSelectors = specs.map((spec) => spec.nodeSelector).filter(Boolean) as LabelSelector[];
      const id = policyNode(kind, policy, namespace, [
        ["Endpoint selector", join(endpointSelectors.map(describeSelector), "none")],
        ...(nodeSelectors.length ? [["Node selector (host policy)", join(nodeSelectors.map(describeSelector))] as const] : []),
        ["Rules", ruleCounts(specs)],
        ...(policy.spec?.description ? [["Description", String(policy.spec.description)] as const] : []),
      ]).id;

      if (endpointSelectors.length > 0) {
        linkPods(id, (pod, labels) => (!namespace || pod.metadata.namespace === namespace) && endpointSelectors.some((selector) => selectorMatches(selector, labels)));
      }

      for (const selector of nodeSelectors) {
        for (const node of nodesMatching(selector)) addEdge(id, nodeId.node(node.metadata.name), "config", "host policy");
      }
    }
  }

  for (const policy of list(input, "networkpolicies.networking.k8s.io")) {
    const namespace = policy.metadata.namespace;
    const types = (policy.spec?.policyTypes ?? ["Ingress", ...(policy.spec?.egress ? ["Egress"] : [])]) as string[];
    const id = policyNode("NetworkPolicy", policy, namespace, [
      ["Pod selector", describeSelector(policy.spec?.podSelector)],
      ["Policy types", join(types)],
      ["Rules", `${policy.spec?.ingress?.length ?? 0} ingress, ${policy.spec?.egress?.length ?? 0} egress`],
    ]).id;

    linkPods(id, (pod) => pod.metadata.namespace === namespace && selectorMatches(policy.spec?.podSelector ?? {}, pod.metadata.labels ?? {}));
  }

  // Egress gateway policies: selected pods → policy → gateway nodes
  for (const policy of list(input, "CiliumEgressGatewayPolicy")) {
    const name = policy.metadata.name;
    const selectors = (policy.spec?.selectors ?? []) as Json[];
    const gateways = [policy.spec?.egressGateway, ...((policy.spec?.egressGateways ?? []) as Json[])].filter(Boolean) as Json[];
    const health = healthOfResource(policy);
    const id = addNode({
      id: nodeId.egress(name),
      layer: "egress",
      column: column.podAttached,
      kind: "CiliumEgressGatewayPolicy",
      title: name,
      subtitle: join(policy.spec?.destinationCIDRs ?? []),
      health: health.health,
      healthReason: health.reason,
      ref: { kind: "CiliumEgressGatewayPolicy", name, group: "cilium.io" },
      facts: [
        ["Destinations", join(policy.spec?.destinationCIDRs ?? [])],
        ["Excluded", join(policy.spec?.excludedCIDRs ?? [])],
        ["Gateways", join(gateways.map((gateway) => `nodes ${describeSelector(gateway.nodeSelector)}${gateway.egressIP ? `, IP ${gateway.egressIP}` : ""}${gateway.interface ? `, ${gateway.interface}` : ""}`))],
        ["Source selectors", join(selectors.map((selector) => [selector.podSelector && `pods ${describeSelector(selector.podSelector)}`, selector.namespaceSelector && `namespaces ${describeSelector(selector.namespaceSelector)}`, selector.nodeSelector && `nodes ${describeSelector(selector.nodeSelector)}`].filter(Boolean).join(" in ")))],
      ],
      conditions: conditionsOf(policy.status),
    }).id;

    const nodeLabels = new Map(kubeNodes.map((node) => [node.metadata.name as string, (node.metadata.labels ?? {}) as Record<string, string>]));

    linkPods(id, (pod, labels) =>
      selectors.some(
        (selector) =>
          (!selector.podSelector || selectorMatches(selector.podSelector, labels)) &&
          (!selector.namespaceSelector || selectorMatches(selector.namespaceSelector, namespaceLabels.get(pod.metadata.namespace) ?? {})) &&
          (!selector.nodeSelector || selectorMatches(selector.nodeSelector, nodeLabels.get(pod.spec?.nodeName) ?? {})) &&
          (selector.podSelector || selector.namespaceSelector || selector.nodeSelector),
      ),
    );

    let gatewayNodes = 0;

    for (const gateway of gateways) {
      if (!gateway.nodeSelector) continue;

      for (const node of nodesMatching(gateway.nodeSelector)) {
        addEdge(id, nodeId.node(node.metadata.name), "config", `gateway${gateway.egressIP ? ` ${gateway.egressIP}` : ""}`);
        gatewayNodes++;
      }
    }

    const node = nodes.get(id)!;

    if (gatewayNodes === 0 && !unavailable.has("nodes") && node.health !== "error") {
      node.health = "warn";
      node.healthReason = "No node matches the gateway node selector";
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
};
