import type { Json } from "../common/json";
import type { Schema, SchemaDefinitions } from "../schema/schema";

export type SectionId = "gateway" | "security" | "bgp" | "lb" | "networking" | "observability" | "config" | "other";

export interface PrinterColumn {
  readonly name: string;
  readonly type: string;
  readonly jsonPath: string;
  readonly description?: string;
  readonly priority?: number;
}

export interface ResourceVersion {
  readonly name: string;
  readonly served: boolean;
  readonly storage: boolean;
  readonly deprecated?: boolean;
  readonly deprecationWarning?: string;
  readonly schema?: Schema;
  /** For built-in kinds whose schema comes from OpenAPI v3, the components its $refs point at. */
  readonly definitions?: SchemaDefinitions;
  readonly printerColumns: readonly PrinterColumn[];
  readonly hasStatusSubresource: boolean;
}

export interface ResourceType {
  /** `plural.group`, as kubectl names a CRD: stable across versions. */
  readonly id: string;
  readonly group: string;
  readonly kind: string;
  readonly plural: string;
  readonly singular: string;
  readonly shortNames: readonly string[];
  readonly namespaced: boolean;
  readonly versions: readonly ResourceVersion[];
  readonly preferredVersion: string;
  readonly section: SectionId;
  readonly title: string;
  readonly order: number;
  readonly source: "crd" | "builtin";
  readonly description?: string;
  /** Labels and annotations of the CRD: bundle version and channel for the Gateway API. */
  readonly crdLabels?: Readonly<Record<string, string>>;
  readonly crdAnnotations?: Readonly<Record<string, string>>;
}

interface KnownKind {
  readonly kind: string;
  readonly section: SectionId;
  readonly title: string;
  readonly order: number;
  readonly description: string;
  readonly legacy?: boolean;
}

/** Kinds this extension knows where to put. Anything else discovered in a Cilium group goes to "Other". */
export const knownKinds: readonly KnownKind[] = [
  { kind: "GatewayClass", section: "gateway", title: "GatewayClasses", order: 10, description: "Classes of Gateways and the controller that implements them." },
  { kind: "Gateway", section: "gateway", title: "Gateways", order: 20, description: "Load balancers with listeners that routes attach to." },
  { kind: "HTTPRoute", section: "gateway", title: "HTTPRoutes", order: 30, description: "HTTP routing rules from Gateway listeners to backends." },
  { kind: "GRPCRoute", section: "gateway", title: "GRPCRoutes", order: 40, description: "gRPC routing rules by service and method." },
  { kind: "TLSRoute", section: "gateway", title: "TLSRoutes", order: 50, description: "TLS passthrough routing by SNI." },
  { kind: "TCPRoute", section: "gateway", title: "TCPRoutes", order: 60, description: "Layer 4 TCP forwarding." },
  { kind: "UDPRoute", section: "gateway", title: "UDPRoutes", order: 70, description: "Layer 4 UDP forwarding." },
  { kind: "ReferenceGrant", section: "gateway", title: "ReferenceGrants", order: 80, description: "Permission for cross-namespace references." },
  { kind: "BackendTLSPolicy", section: "gateway", title: "BackendTLSPolicies", order: 90, description: "TLS from the gateway to backends." },
  { kind: "ListenerSet", section: "gateway", title: "ListenerSets", order: 100, description: "Listeners attached to a Gateway from another resource." },
  { kind: "XListenerSet", section: "gateway", title: "XListenerSets", order: 101, description: "Experimental ListenerSets." },
  { kind: "CiliumGatewayClassConfig", section: "gateway", title: "CiliumGatewayClassConfigs", order: 110, description: "Cilium parameters for a GatewayClass." },

  { kind: "CiliumNetworkPolicy", section: "security", title: "CiliumNetworkPolicies", order: 10, description: "Namespaced L3–L7 policies." },
  { kind: "CiliumClusterwideNetworkPolicy", section: "security", title: "CiliumClusterwideNetworkPolicies", order: 20, description: "Cluster-wide policies, including host policies." },
  { kind: "NetworkPolicy", section: "security", title: "Kubernetes NetworkPolicies", order: 30, description: "Standard Kubernetes network policies, enforced by Cilium." },

  { kind: "CiliumBGPClusterConfig", section: "bgp", title: "CiliumBGPClusterConfigs", order: 10, description: "BGP instances and peers for groups of nodes." },
  { kind: "CiliumBGPPeerConfig", section: "bgp", title: "CiliumBGPPeerConfigs", order: 20, description: "Peer settings: timers, auth, families." },
  { kind: "CiliumBGPAdvertisement", section: "bgp", title: "CiliumBGPAdvertisements", order: 30, description: "What prefixes are advertised to peers." },
  { kind: "CiliumBGPNodeConfig", section: "bgp", title: "CiliumBGPNodeConfigs", order: 40, description: "Per-node BGP configuration and session status." },
  { kind: "CiliumBGPNodeConfigOverride", section: "bgp", title: "CiliumBGPNodeConfigOverrides", order: 50, description: "Per-node overrides of router ID and addresses." },
  { kind: "CiliumBGPPeeringPolicy", section: "bgp", title: "CiliumBGPPeeringPolicies (legacy)", order: 60, description: "The v1 BGP control plane, superseded by CiliumBGPClusterConfig.", legacy: true },

  { kind: "CiliumLoadBalancerIPPool", section: "lb", title: "CiliumLoadBalancerIPPools", order: 10, description: "Address ranges LB-IPAM assigns to LoadBalancer Services." },
  { kind: "CiliumL2AnnouncementPolicy", section: "lb", title: "CiliumL2AnnouncementPolicies", order: 20, description: "Which nodes answer ARP/NDP for service addresses." },
  { kind: "CiliumNodeConfig", section: "lb", title: "CiliumNodeConfigs", order: 30, description: "Per-node overrides of the agent configuration." },
  { kind: "CiliumCIDRGroup", section: "lb", title: "CiliumCIDRGroups", order: 40, description: "Named lists of CIDRs referenced from policies." },
  { kind: "CiliumPodIPPool", section: "lb", title: "CiliumPodIPPools", order: 50, description: "Pod IP pools for multi-pool IPAM." },

  { kind: "CiliumNode", section: "networking", title: "CiliumNodes", order: 10, description: "Cilium's view of each node: addresses, IPAM, encryption." },
  { kind: "CiliumEndpoint", section: "networking", title: "CiliumEndpoints", order: 20, description: "Every managed endpoint with its identity and policy state." },
  { kind: "CiliumEndpointSlice", section: "networking", title: "CiliumEndpointSlices", order: 30, description: "Batched endpoints, when CES is enabled." },
  { kind: "CiliumIdentity", section: "networking", title: "CiliumIdentities", order: 40, description: "Security identities derived from labels." },
  { kind: "CiliumLocalRedirectPolicy", section: "networking", title: "CiliumLocalRedirectPolicies", order: 50, description: "Redirect traffic to node-local backends." },
  { kind: "CiliumEgressGatewayPolicy", section: "networking", title: "CiliumEgressGatewayPolicies", order: 60, description: "Route egress through gateway nodes with fixed addresses." },
  { kind: "CiliumEnvoyConfig", section: "networking", title: "CiliumEnvoyConfigs", order: 70, description: "Namespaced Envoy listeners, routes and clusters." },
  { kind: "CiliumClusterwideEnvoyConfig", section: "networking", title: "CiliumClusterwideEnvoyConfigs", order: 80, description: "Cluster-wide Envoy configuration." },
  { kind: "CiliumExternalWorkload", section: "networking", title: "CiliumExternalWorkloads", order: 90, description: "VMs and hosts outside Kubernetes joined to the mesh." },
];

export const knownKindsByName = new Map(knownKinds.map((known) => [known.kind, known]));

/** Whether discovery should include a CRD of this group. */
export const isWatchedGroup = (group: string) =>
  group === "cilium.io" || group.endsWith(".cilium.io") || group === "gateway.networking.k8s.io" || group === "gateway.networking.x-k8s.io";

export const isGatewayGroup = (group: string) => group === "gateway.networking.k8s.io" || group === "gateway.networking.x-k8s.io";

/** Kubernetes' version priority: GA over beta over alpha, higher numbers first, then anything else alphabetically. */
export const compareVersions = (a: string, b: string) => {
  const parse = (version: string) => {
    const match = /^v(\d+)(?:(alpha|beta)(\d+))?$/.exec(version);

    if (!match) {
      return [0, 0, 0, version] as const;
    }

    const stability = match[2] === undefined ? 3 : match[2] === "beta" ? 2 : 1;

    return [stability, Number(match[1]), Number(match[3] ?? 0), version] as const;
  };

  const [sa, ma, na, va] = parse(a);
  const [sb, mb, nb, vb] = parse(b);

  return sb - sa || mb - ma || nb - na || va.localeCompare(vb);
};

export const apiVersionOf = (type: Pick<ResourceType, "group">, version: string) => (type.group ? `${type.group}/${version}` : version);

/** The fully qualified name kubectl accepts for one version of a type: `plural.version.group`. */
export const kubectlResourceName = (type: Pick<ResourceType, "group" | "plural">, version: string) =>
  type.group ? `${type.plural}.${version}.${type.group}` : type.plural;

export const versionOf = (type: ResourceType, version?: string): ResourceVersion | undefined =>
  type.versions.find((candidate) => candidate.name === (version ?? type.preferredVersion));

const sectionFor = (group: string, kind: string): Pick<KnownKind, "section" | "title" | "order" | "description"> => {
  const known = knownKindsByName.get(kind);

  if (known) {
    return known;
  }

  return {
    section: isGatewayGroup(group) ? "gateway" : "other",
    title: `${kind}s`,
    order: 500,
    description: `${kind} (${group})`,
  };
};

/** Turns the CRDs `kubectl get crd -o json` lists into resource types, keeping only Cilium and Gateway API groups. */
export const resourceTypesFromCrds = (crdList: Json): ResourceType[] => {
  const types: ResourceType[] = [];

  for (const crd of (crdList?.items ?? []) as Json[]) {
    const spec = crd?.spec;

    if (!spec?.group || !isWatchedGroup(spec.group)) {
      continue;
    }

    const versions: ResourceVersion[] = ((spec.versions ?? []) as Json[])
      .map((version) => ({
        name: String(version.name),
        served: version.served !== false,
        storage: version.storage === true,
        deprecated: version.deprecated === true,
        deprecationWarning: version.deprecationWarning,
        schema: version.schema?.openAPIV3Schema ?? spec.validation?.openAPIV3Schema,
        printerColumns: ((version.additionalPrinterColumns ?? spec.additionalPrinterColumns ?? []) as Json[]).map((column) => ({
          name: String(column.name),
          type: String(column.type ?? "string"),
          jsonPath: String(column.jsonPath ?? column.JSONPath ?? ""),
          description: column.description,
          priority: column.priority,
        })),
        hasStatusSubresource: Boolean(version.subresources?.status ?? spec.subresources?.status),
      }))
      .sort((a, b) => compareVersions(a.name, b.name));

    const served = versions.filter((version) => version.served);

    if (served.length === 0) {
      continue;
    }

    const kind = String(spec.names.kind);
    const section = sectionFor(spec.group, kind);

    types.push({
      id: `${spec.names.plural}.${spec.group}`,
      group: spec.group,
      kind,
      plural: spec.names.plural,
      singular: spec.names.singular ?? kind.toLowerCase(),
      shortNames: spec.names.shortNames ?? [],
      namespaced: spec.scope === "Namespaced",
      versions,
      preferredVersion: served[0].name,
      ...section,
      source: "crd",
      crdLabels: crd.metadata?.labels,
      crdAnnotations: crd.metadata?.annotations,
    });
  }

  return types.sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order || a.kind.localeCompare(b.kind));
};

/** Parses `kubectl api-resources -o wide --no-headers`, the fallback when listing CRDs is forbidden. */
export const resourceTypesFromApiResources = (output: string): ResourceType[] => {
  const types: ResourceType[] = [];

  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);

    if (columns.length < 4) {
      continue;
    }

    // NAME [SHORTNAMES] APIVERSION NAMESPACED KIND VERBS [CATEGORIES]
    const apiVersionIndex = columns.findIndex((column, index) => index > 0 && /\//.test(column) && (columns[index + 1] === "true" || columns[index + 1] === "false"));

    if (apiVersionIndex < 0) {
      continue;
    }

    const [group, version] = columns[apiVersionIndex].split("/");

    if (!isWatchedGroup(group)) {
      continue;
    }

    const plural = columns[0];
    const kind = columns[apiVersionIndex + 2];
    const section = sectionFor(group, kind);

    types.push({
      id: `${plural}.${group}`,
      group,
      kind,
      plural,
      singular: kind.toLowerCase(),
      shortNames: apiVersionIndex > 1 ? columns[1].split(",") : [],
      namespaced: columns[apiVersionIndex + 1] === "true",
      versions: [{ name: version, served: true, storage: true, printerColumns: [], hasStatusSubresource: true }],
      preferredVersion: version,
      ...section,
      source: "crd",
    });
  }

  return types;
};

/** Built-in kinds the extension manages beside the CRDs; their schemas come from OpenAPI v3 when asked for. */
export const networkPolicyType: ResourceType = {
  id: "networkpolicies.networking.k8s.io",
  group: "networking.k8s.io",
  kind: "NetworkPolicy",
  plural: "networkpolicies",
  singular: "networkpolicy",
  shortNames: ["netpol"],
  namespaced: true,
  versions: [{ name: "v1", served: true, storage: true, printerColumns: [{ name: "Pod selector", type: "string", jsonPath: ".spec.podSelector" }], hasStatusSubresource: false }],
  preferredVersion: "v1",
  section: "security",
  title: "Kubernetes NetworkPolicies",
  order: 30,
  source: "builtin",
  description: "Standard Kubernetes network policies, enforced by Cilium.",
};

export const serviceType: ResourceType = {
  id: "services",
  group: "",
  kind: "Service",
  plural: "services",
  singular: "service",
  shortNames: ["svc"],
  namespaced: true,
  versions: [{ name: "v1", served: true, storage: true, printerColumns: [], hasStatusSubresource: true }],
  preferredVersion: "v1",
  section: "lb",
  title: "Services",
  order: 900,
  source: "builtin",
};

export const builtinTypes: readonly ResourceType[] = [networkPolicyType];

/** Finds, in an OpenAPI v3 document, the schema of a group/version/kind and returns it with the components to resolve against. */
export const schemaFromOpenApi = (document: Json, group: string, version: string, kind: string): { schema?: Schema; definitions: SchemaDefinitions } => {
  const definitions: SchemaDefinitions = document?.components?.schemas ?? {};

  for (const [, schema] of Object.entries(definitions)) {
    const gvks = ((schema as Json)["x-kubernetes-group-version-kind"] ?? []) as Json[];

    if (gvks.some((gvk) => (gvk.group ?? "") === group && gvk.version === version && gvk.kind === kind)) {
      return { schema: schema as Schema, definitions };
    }
  }

  return { definitions };
};
