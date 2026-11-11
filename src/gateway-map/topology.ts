import type { KindName } from "./kinds";

/* eslint-disable @typescript-eslint/no-explicit-any -- the snapshot is kubectl's JSON, read defensively */
type Json = any;

export type Health = "ok" | "warn" | "error" | "unknown";

export interface ResourceRef {
  readonly kind: KindName;
  readonly name: string;
  readonly namespace?: string;
}

export interface Condition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
}

export interface MapNode {
  readonly id: string;
  readonly column: number;
  readonly kindLabel: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly health: Health;
  readonly healthReason?: string;
  readonly ref?: ResourceRef;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  readonly conditions: readonly Condition[];
  readonly related: ReadonlyArray<{ readonly label: string; readonly ref: ResourceRef; readonly note?: string }>;
  readonly rules?: readonly string[];
}

export interface MapEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly health: Health;
}

export interface Topology {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
}

/** What is read from the cluster: the items of each resource type, by the plural kubectl knows it as. */
export type Snapshot = Readonly<Record<SnapshotResource, readonly Json[]>>;

export const snapshotResources = [
  "gatewayclasses.gateway.networking.k8s.io",
  "gateways.gateway.networking.k8s.io",
  "listenersets.gateway.networking.k8s.io",
  "httproutes.gateway.networking.k8s.io",
  "grpcroutes.gateway.networking.k8s.io",
  "tlsroutes.gateway.networking.k8s.io",
  "tcproutes.gateway.networking.k8s.io",
  "udproutes.gateway.networking.k8s.io",
  "ciliumenvoyconfigs.cilium.io",
  "ciliumloadbalancerippools.cilium.io",
  "services",
  "endpointslices.discovery.k8s.io",
] as const;

export type SnapshotResource = (typeof snapshotResources)[number];

export const columns = ["Gateway classes", "Gateways", "Listeners", "Routes", "Backends"] as const;

const routeResources: ReadonlyArray<readonly [SnapshotResource, KindName]> = [
  ["httproutes.gateway.networking.k8s.io", "HTTPRoute"],
  ["grpcroutes.gateway.networking.k8s.io", "GRPCRoute"],
  ["tlsroutes.gateway.networking.k8s.io", "TLSRoute"],
  ["tcproutes.gateway.networking.k8s.io", "TCPRoute"],
  ["udproutes.gateway.networking.k8s.io", "UDPRoute"],
];

const key = (namespace: string | undefined, name: string) => (namespace ? `${namespace}/${name}` : name);

const conditionsOf = (status: Json): Condition[] =>
  ((status?.conditions ?? []) as Json[]).map((condition) => ({
    type: String(condition.type),
    status: String(condition.status),
    reason: condition.reason,
    message: condition.message,
  }));

const isTrue = (conditions: readonly Condition[], type: string) =>
  conditions.some((condition) => condition.type === type && condition.status === "True");

const firstFalse = (conditions: readonly Condition[]) => conditions.find((condition) => condition.status !== "True");

const healthOf = (conditions: readonly Condition[], required: readonly string[]): Pick<MapNode, "health" | "healthReason"> => {
  if (conditions.length === 0) {
    return { health: "unknown", healthReason: "No status reported yet" };
  }

  const failing = firstFalse(conditions.filter((condition) => required.includes(condition.type)));

  if (failing) {
    return { health: "error", healthReason: `${failing.type}: ${failing.reason ?? failing.status}` };
  }

  if (!required.every((type) => isTrue(conditions, type))) {
    return { health: "warn", healthReason: `Waiting for ${required.filter((type) => !isTrue(conditions, type)).join(", ")}` };
  }

  return { health: "ok" };
};

const ipToNumber = (ip: string) => {
  const parts = ip.split(".").map(Number);

  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part < 256)
    ? parts.reduce((sum, part) => sum * 256 + part, 0)
    : undefined;
};

const blockContains = (block: Json, ip: string) => {
  const address = ipToNumber(ip);

  if (address === undefined) {
    return false;
  }

  if (typeof block.cidr === "string") {
    const [base, bits] = block.cidr.split("/");
    const start = ipToNumber(base);
    const size = 2 ** (32 - Number(bits));

    return start !== undefined && address >= start - (start % size) && address < start - (start % size) + size;
  }

  const start = ipToNumber(block.start ?? "");
  const stop = ipToNumber(block.stop ?? block.start ?? "");

  return start !== undefined && stop !== undefined && address >= start && address <= stop;
};

const describeMatch = (match: Json): string => {
  const parts: string[] = [];

  // An HTTPRoute matches a method by name; a GRPCRoute matches a service and method as an object.
  if (typeof match?.method === "string") {
    parts.push(match.method);
  } else if (match?.method) {
    parts.push(`${match.method.service ?? "*"}/${match.method.method ?? "*"}`);
  }

  if (match?.path) {
    parts.push(match.path.type === "Exact" ? `= ${match.path.value}` : match.path.type === "RegularExpression" ? `~ ${match.path.value}` : `${match.path.value}`);
  }

  for (const header of match?.headers ?? []) {
    parts.push(`${header.name}: ${header.value}`);
  }

  return parts.join(" ") || "*";
};

const describeRule = (rule: Json): string => {
  const matches = ((rule.matches ?? []) as Json[]).map(describeMatch);
  const when = matches.length ? matches.join(" | ") : "*";
  const redirect = ((rule.filters ?? []) as Json[]).find((filter) => filter.type === "RequestRedirect")?.requestRedirect;

  if (redirect) {
    const target = [redirect.scheme, redirect.hostname, redirect.port].filter(Boolean).join(" ");

    return `${when} → redirect ${target} ${redirect.statusCode ?? 302}`.replace(/\s+/g, " ");
  }

  const backends = ((rule.backendRefs ?? []) as Json[]).map(
    (backend) => `${backend.name}${backend.port ? `:${backend.port}` : ""}${backend.weight !== undefined && (rule.backendRefs?.length ?? 0) > 1 ? ` (w${backend.weight})` : ""}`,
  );

  return `${when} → ${backends.join(", ") || "no backend"}`;
};

export const buildTopology = (snapshot: Snapshot): Topology => {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();

  const addEdge = (from: string, to: string, health: Health, label?: string) => {
    const id = `${from}->${to}`;
    const existing = edges.get(id);

    edges.set(id, {
      id,
      from,
      to,
      health: existing && existing.health !== "ok" ? existing.health : health,
      label: [existing?.label, label].filter(Boolean).join(", ") || undefined,
    });
  };

  // Gateway classes
  for (const gatewayClass of snapshot["gatewayclasses.gateway.networking.k8s.io"]) {
    const conditions = conditionsOf(gatewayClass.status);

    nodes.set(`class:${gatewayClass.metadata.name}`, {
      id: `class:${gatewayClass.metadata.name}`,
      column: 0,
      kindLabel: "GatewayClass",
      title: gatewayClass.metadata.name,
      subtitle: gatewayClass.spec?.controllerName,
      ...healthOf(conditions, ["Accepted"]),
      ref: { kind: "GatewayClass", name: gatewayClass.metadata.name },
      facts: [
        ["Controller", gatewayClass.spec?.controllerName ?? "—"],
        ...(gatewayClass.spec?.parametersRef
          ? [["Parameters", `${gatewayClass.spec.parametersRef.kind} ${key(gatewayClass.spec.parametersRef.namespace, gatewayClass.spec.parametersRef.name)}`] as const]
          : []),
      ],
      conditions,
      related: [],
    });
  }

  // Listeners, by the parent they belong to: a Gateway or a ListenerSet.
  const listenersOf = new Map<string, Array<{ id: string; name: string; port?: number }>>();

  const addListener = (parentKey: string, ownerKind: "Gateway" | "ListenerSet", owner: Json, listener: Json, status: Json) => {
    const conditions = conditionsOf(status);
    const id = `listener:${ownerKind}:${key(owner.metadata.namespace, owner.metadata.name)}:${listener.name}`;
    const fromSet = ownerKind === "ListenerSet" ? `set ${owner.metadata.name} · ` : "";

    nodes.set(id, {
      id,
      column: 2,
      kindLabel: ownerKind === "ListenerSet" ? "ListenerSet listener" : "Listener",
      title: `${fromSet}${listener.name}`,
      subtitle: `${listener.protocol} :${listener.port}${listener.hostname ? ` · ${listener.hostname}` : ""}`,
      ...healthOf(conditions, ["Accepted", "Programmed", "ResolvedRefs"]),
      ref: { kind: ownerKind, name: owner.metadata.name, namespace: owner.metadata.namespace },
      facts: [
        ["Protocol", listener.protocol],
        ["Port", String(listener.port)],
        ["Hostname", listener.hostname ?? "any"],
        ["Routes from", listener.allowedRoutes?.namespaces?.from ?? "Same"],
        ["Attached routes", String(status?.attachedRoutes ?? 0)],
        ...((listener.tls?.certificateRefs ?? []) as Json[]).map(
          (certificate) => ["TLS certificate", `${certificate.kind ?? "Secret"} ${key(certificate.namespace ?? owner.metadata.namespace, certificate.name)}`] as const,
        ),
      ],
      conditions,
      related: [],
    });

    listenersOf.set(parentKey, [...(listenersOf.get(parentKey) ?? []), { id, name: listener.name, port: listener.port }]);

    return id;
  };

  // Gateways, with what Cilium made of each: the LoadBalancer Service, its Envoy config and the IP pool.
  for (const gateway of snapshot["gateways.gateway.networking.k8s.io"]) {
    const { name, namespace, uid } = gateway.metadata;
    const id = `gateway:${key(namespace, name)}`;
    const conditions = conditionsOf(gateway.status);
    const addresses = ((gateway.status?.addresses ?? gateway.spec?.addresses ?? []) as Json[]).map((address) => String(address.value));

    const loadBalancer = snapshot.services.find(
      (service) =>
        service.metadata.namespace === namespace &&
        (service.metadata.labels?.["gateway.networking.k8s.io/gateway-name"] === name ||
          service.metadata.labels?.["io.cilium.gateway/owning-gateway"] === name),
    );
    const envoyConfig = snapshot["ciliumenvoyconfigs.cilium.io"].find(
      (config) =>
        config.metadata.namespace === namespace &&
        ((config.metadata.ownerReferences ?? []) as Json[]).some((owner) => owner.uid === uid),
    ) ?? snapshot["ciliumenvoyconfigs.cilium.io"].find((config) => config.metadata.namespace === namespace && config.metadata.name === `cilium-gateway-${name}`);
    const pools = snapshot["ciliumloadbalancerippools.cilium.io"].filter((pool) =>
      addresses.some((address) => ((pool.spec?.blocks ?? pool.spec?.cidrs ?? []) as Json[]).some((block) => blockContains(block, address))),
    );

    nodes.set(id, {
      id,
      column: 1,
      kindLabel: "Gateway",
      title: name,
      subtitle: `${namespace} · ${addresses.join(", ") || "no address"}`,
      ...healthOf(conditions, ["Accepted", "Programmed"]),
      ref: { kind: "Gateway", name, namespace },
      facts: [
        ["Namespace", namespace],
        ["Class", gateway.spec?.gatewayClassName ?? "—"],
        ["Addresses", addresses.join(", ") || "none assigned"],
        ["Listeners", String(gateway.spec?.listeners?.length ?? 0)],
        ...(gateway.spec?.allowedListeners
          ? [["ListenerSets from", gateway.spec.allowedListeners.namespaces?.from ?? "None"] as const]
          : []),
        ...(gateway.status?.attachedListenerSets !== undefined
          ? [["Attached ListenerSets", String(gateway.status.attachedListenerSets)] as const]
          : []),
      ],
      conditions,
      related: [
        ...(loadBalancer
          ? [{
              label: "LoadBalancer Service",
              ref: { kind: "Service", name: loadBalancer.metadata.name, namespace } as ResourceRef,
              note: `${loadBalancer.spec?.type} ${loadBalancer.spec?.clusterIP ?? ""} → ${(loadBalancer.status?.loadBalancer?.ingress ?? []).map((ingress: Json) => ingress.ip ?? ingress.hostname).join(", ") || "pending"}`,
            }]
          : []),
        ...(envoyConfig
          ? [{ label: "CiliumEnvoyConfig", ref: { kind: "CiliumEnvoyConfig", name: envoyConfig.metadata.name, namespace } as ResourceRef, note: `${envoyConfig.spec?.resources?.length ?? 0} Envoy resources` }]
          : []),
        ...pools.map((pool) => ({
          label: "LB IP pool",
          ref: { kind: "CiliumLoadBalancerIPPool", name: pool.metadata.name } as ResourceRef,
          note: ((pool.spec?.blocks ?? pool.spec?.cidrs ?? []) as Json[]).map((block) => block.cidr ?? `${block.start}–${block.stop ?? block.start}`).join(", "),
        })),
      ],
    });

    const classId = `class:${gateway.spec?.gatewayClassName}`;

    if (nodes.has(classId)) {
      addEdge(classId, id, nodes.get(id)!.health === "error" ? "error" : "ok");
    }

    const listenerStatuses = (gateway.status?.listeners ?? []) as Json[];

    for (const listener of (gateway.spec?.listeners ?? []) as Json[]) {
      const listenerId = addListener(`Gateway:${key(namespace, name)}`, "Gateway", gateway, listener, listenerStatuses.find((status) => status.name === listener.name));

      addEdge(id, listenerId, nodes.get(listenerId)!.health === "error" ? "error" : "ok");
    }
  }

  // ListenerSets hang their listeners under the Gateway they attach to.
  for (const listenerSet of snapshot["listenersets.gateway.networking.k8s.io"]) {
    const { name, namespace } = listenerSet.metadata;
    const parent = listenerSet.spec?.parentRef ?? {};
    const gatewayId = `gateway:${key(parent.namespace ?? namespace, parent.name)}`;
    const setConditions = conditionsOf(listenerSet.status);
    const setHealth = healthOf(setConditions, ["Accepted", "Programmed"]);
    const listenerStatuses = (listenerSet.status?.listeners ?? []) as Json[];

    for (const listener of (listenerSet.spec?.listeners ?? []) as Json[]) {
      const listenerId = addListener(`ListenerSet:${key(namespace, name)}`, "ListenerSet", listenerSet, listener, listenerStatuses.find((status) => status.name === listener.name));

      if (nodes.has(gatewayId)) {
        addEdge(gatewayId, listenerId, setHealth.health === "error" ? "error" : setHealth.health === "ok" ? "ok" : "warn");
      }
    }
  }

  // Routes, attached to listeners by their parentRefs, and to their backends by their rules.
  const endpointsOf = (namespace: string, name: string) => {
    const slices = snapshot["endpointslices.discovery.k8s.io"].filter(
      (slice) => slice.metadata.namespace === namespace && slice.metadata.labels?.["kubernetes.io/service-name"] === name,
    );
    const endpoints = slices.flatMap((slice) => (slice.endpoints ?? []) as Json[]);

    return { ready: endpoints.filter((endpoint) => endpoint.conditions?.ready !== false).length, total: endpoints.length };
  };

  for (const [resource, kindName] of routeResources) {
    for (const route of snapshot[resource]) {
      const { name, namespace } = route.metadata;
      const id = `route:${kindName}:${key(namespace, name)}`;
      const parentStatuses = (route.status?.parents ?? []) as Json[];
      const allConditions = parentStatuses.flatMap((status) => conditionsOf(status));
      const hostnames = (route.spec?.hostnames ?? []) as string[];
      const rules = (route.spec?.rules ?? []) as Json[];

      nodes.set(id, {
        id,
        column: 3,
        kindLabel: kindName,
        title: name,
        subtitle: `${namespace}${hostnames.length ? ` · ${hostnames.join(", ")}` : ""}`,
        ...healthOf(allConditions, ["Accepted", "ResolvedRefs"]),
        ref: { kind: kindName, name, namespace },
        facts: [
          ["Namespace", namespace],
          ["Hostnames", hostnames.join(", ") || "any"],
          ["Parents", ((route.spec?.parentRefs ?? []) as Json[]).map((parent) => `${parent.kind ?? "Gateway"} ${key(parent.namespace ?? namespace, parent.name)}${parent.sectionName ? `#${parent.sectionName}` : ""}`).join(", ")],
        ],
        conditions: parentStatuses.flatMap((status) =>
          conditionsOf(status).map((condition) => ({ ...condition, type: `${condition.type} (${status.parentRef?.kind ?? "Gateway"} ${status.parentRef?.name}${status.parentRef?.sectionName ? `#${status.parentRef.sectionName}` : ""})` })),
        ),
        related: [],
        rules: rules.map(describeRule),
      });

      for (const parentRef of (route.spec?.parentRefs ?? []) as Json[]) {
        const parentKind = parentRef.kind ?? "Gateway";
        const listeners = (listenersOf.get(`${parentKind}:${key(parentRef.namespace ?? namespace, parentRef.name)}`) ?? []).filter(
          (listener) => (!parentRef.sectionName || listener.name === parentRef.sectionName) && (!parentRef.port || listener.port === parentRef.port),
        );
        const status = parentStatuses.find(
          (candidate) =>
            (candidate.parentRef?.kind ?? "Gateway") === parentKind &&
            candidate.parentRef?.name === parentRef.name &&
            (candidate.parentRef?.sectionName ?? "") === (parentRef.sectionName ?? ""),
        );
        const statusConditions = conditionsOf(status);
        const edgeHealth: Health = !status ? "warn" : isTrue(statusConditions, "Accepted") && isTrue(statusConditions, "ResolvedRefs") ? "ok" : "error";

        for (const listener of listeners) {
          addEdge(listener.id, id, edgeHealth);
        }
      }

      for (const rule of rules) {
        const when = ((rule.matches ?? []) as Json[]).map(describeMatch).join(" | ") || "*";

        for (const backend of (rule.backendRefs ?? []) as Json[]) {
          const backendKind = backend.kind ?? "Service";
          const backendNamespace = backend.namespace ?? namespace;
          const backendId = `backend:${backendKind}:${key(backendNamespace, backend.name)}`;

          if (!nodes.has(backendId)) {
            const service = backendKind === "Service"
              ? snapshot.services.find((candidate) => candidate.metadata.namespace === backendNamespace && candidate.metadata.name === backend.name)
              : undefined;
            const endpoints = endpointsOf(backendNamespace, backend.name);

            nodes.set(backendId, {
              id: backendId,
              column: 4,
              kindLabel: backendKind,
              title: backend.name,
              subtitle: backendKind === "Service"
                ? service
                  ? `${backendNamespace} · ${endpoints.ready}/${endpoints.total} endpoints ready`
                  : `${backendNamespace} · not found`
                : backendNamespace,
              health: backendKind !== "Service" ? "unknown" : !service ? "error" : endpoints.ready === 0 ? "warn" : "ok",
              healthReason: backendKind !== "Service" ? undefined : !service ? "Service not found" : endpoints.ready === 0 ? "No ready endpoints" : undefined,
              ref: backendKind === "Service" && service ? { kind: "Service", name: backend.name, namespace: backendNamespace } : undefined,
              facts: service
                ? [
                    ["Namespace", backendNamespace],
                    ["Type", service.spec?.type ?? "ClusterIP"],
                    ["Cluster IP", service.spec?.clusterIP ?? "—"],
                    ["Ports", ((service.spec?.ports ?? []) as Json[]).map((port) => `${port.name ? `${port.name} ` : ""}${port.port}→${port.targetPort}/${port.protocol ?? "TCP"}`).join(", ")],
                    ["Endpoints ready", `${endpoints.ready} of ${endpoints.total}`],
                  ]
                : [["Namespace", backendNamespace], ["Kind", backendKind]],
              conditions: [],
              related: [],
            });
          }

          const backendHealth = nodes.get(backendId)!.health;

          addEdge(id, backendId, backendHealth === "error" ? "error" : backendHealth === "warn" ? "warn" : "ok", `${when}${backend.port ? ` :${backend.port}` : ""}`);
        }
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
};

export const nodeWidth = 248;
export const nodeHeight = 80;
export const columnGap = 96;
export const rowGap = 20;
export const headerHeight = 32;

export interface PositionedNode extends MapNode {
  readonly x: number;
  readonly y: number;
}

/** Places nodes in their columns, ordering each column by where its parents sit so lines cross less. */
export const layOut = (topology: Topology): { nodes: PositionedNode[]; width: number; height: number } => {
  const parentsOf = new Map<string, string[]>();

  for (const edge of topology.edges) {
    parentsOf.set(edge.to, [...(parentsOf.get(edge.to) ?? []), edge.from]);
  }

  const rowOf = new Map<string, number>();
  const byColumn = columns.map((_, column) => topology.nodes.filter((node) => node.column === column));

  byColumn.forEach((columnNodes, column) => {
    const barycenter = (node: MapNode) => {
      const rows = (parentsOf.get(node.id) ?? []).map((parent) => rowOf.get(parent)).filter((row): row is number => row !== undefined);

      return rows.length ? rows.reduce((sum, row) => sum + row, 0) / rows.length : Number.MAX_SAFE_INTEGER;
    };

    const sorted = column === 0
      ? [...columnNodes].sort((a, b) => a.title.localeCompare(b.title))
      : [...columnNodes].sort((a, b) => barycenter(a) - barycenter(b) || a.title.localeCompare(b.title));

    sorted.forEach((node, row) => rowOf.set(node.id, row));
    byColumn[column] = sorted;
  });

  const tallest = Math.max(1, ...byColumn.map((columnNodes) => columnNodes.length));
  const height = headerHeight + tallest * (nodeHeight + rowGap);

  const nodes = byColumn.flatMap((columnNodes, column) => {
    // Centre shorter columns against the tallest, so a lone gateway sits level with its listeners.
    const offset = ((tallest - columnNodes.length) * (nodeHeight + rowGap)) / 2;

    return columnNodes.map((node, row) => ({
      ...node,
      x: column * (nodeWidth + columnGap),
      y: headerHeight + offset + row * (nodeHeight + rowGap),
    }));
  });

  return { nodes, width: columns.length * nodeWidth + (columns.length - 1) * columnGap, height };
};

/** Every node upstream and downstream of one, so a selection lights up its whole path. */
export const pathThrough = (topology: Topology, id: string): Set<string> => {
  const seen = new Set<string>([id]);

  const walk = (start: string, next: (edge: MapEdge) => string | undefined) => {
    const queue = [start];

    while (queue.length) {
      const current = queue.shift()!;

      for (const edge of topology.edges) {
        const other = next(edge) === current ? (edge.from === current ? edge.to : edge.from) : undefined;

        if (other && !seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
  };

  walk(id, (edge) => edge.from);
  walk(id, (edge) => edge.to);

  return seen;
};
