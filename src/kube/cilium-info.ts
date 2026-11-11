import type { Json } from "../common/json";
import type { KubectlClient } from "./kubectl";
import { KubeError } from "./kubectl";
import type { ResourceType } from "./resource-types";

export interface AgentPod {
  readonly name: string;
  readonly namespace: string;
  readonly node?: string;
  readonly phase?: string;
  readonly ready: boolean;
  readonly restarts: number;
  readonly image?: string;
  readonly containers: readonly string[];
}

export interface CiliumInfo {
  /** Where the agent runs, or undefined when no Cilium agent pods were found. */
  readonly namespace?: string;
  readonly version?: string;
  readonly agents: readonly AgentPod[];
  readonly operators: readonly AgentPod[];
  readonly relays: readonly AgentPod[];
  readonly envoys: readonly AgentPod[];
  /** The agent configuration (the `cilium-config` ConfigMap), when readable. */
  readonly config?: Readonly<Record<string, string>>;
  readonly configError?: string;
  readonly podsError?: string;
}

const toPod = (pod: Json): AgentPod => {
  const statuses = (pod.status?.containerStatuses ?? []) as Json[];

  return {
    name: pod.metadata.name,
    namespace: pod.metadata.namespace,
    node: pod.spec?.nodeName,
    phase: pod.status?.phase,
    ready: statuses.length > 0 && statuses.every((status) => status.ready),
    restarts: statuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
    image: pod.spec?.containers?.[0]?.image,
    containers: ((pod.spec?.containers ?? []) as Json[]).map((container) => container.name),
  };
};

export const versionFromImage = (image: string | undefined): string | undefined => {
  if (!image) {
    return undefined;
  }

  const withoutDigest = image.split("@")[0];
  const tag = withoutDigest.includes(":") && !withoutDigest.endsWith("/") ? withoutDigest.slice(withoutDigest.lastIndexOf(":") + 1) : undefined;

  return tag && !tag.includes("/") ? tag : undefined;
};

/** Finds Cilium's components by their standard labels in any namespace, and reads the agent configuration. */
export const loadCiliumInfo = async (kubectl: KubectlClient, namespaceOverride?: string): Promise<CiliumInfo> => {
  const scope = namespaceOverride ? ["--namespace", namespaceOverride] : ["--all-namespaces"];
  const listPods = async (selector: string) => {
    const result = await kubectl.json<Json>(["get", "pods", ...scope, "--selector", selector, "--output", "json"]);

    return ((result?.items ?? []) as Json[]).map(toPod);
  };

  let podsError: string | undefined;
  let agents: AgentPod[] = [];
  let operators: AgentPod[] = [];
  let relays: AgentPod[] = [];
  let envoys: AgentPod[] = [];

  try {
    [agents, operators, relays, envoys] = await Promise.all([
      listPods("k8s-app=cilium"),
      listPods("io.cilium/app=operator"),
      listPods("k8s-app=hubble-relay"),
      listPods("k8s-app=cilium-envoy"),
    ]);
  } catch (error) {
    podsError = error instanceof Error ? error.message : String(error);
  }

  const namespace = namespaceOverride ?? agents[0]?.namespace ?? operators[0]?.namespace;
  let config: Record<string, string> | undefined;
  let configError: string | undefined;

  if (namespace) {
    try {
      const configMap = await kubectl.json<Json>(["get", "configmap", "cilium-config", "--namespace", namespace, "--output", "json"]);

      config = configMap?.data ?? {};
    } catch (error) {
      configError = error instanceof KubeError ? error.message : String(error);
    }
  }

  return {
    namespace,
    version: versionFromImage(agents[0]?.image) ?? versionFromImage(operators[0]?.image),
    agents,
    operators,
    relays,
    envoys,
    config,
    configError,
    podsError,
  };
};

export type FeatureState = "enabled" | "disabled" | "unknown";

export interface Feature {
  readonly id: string;
  readonly label: string;
  readonly state: FeatureState;
  readonly detail: string;
  /** Resource types the feature needs installed; missing ones are listed. */
  readonly missingTypes: readonly string[];
}

const truthy = (value: string | undefined) => (value === undefined ? undefined : /^(true|strict|partial|enabled|1)$/i.test(value.trim()));

/** Combines the agent configuration with what is installed into the list of features this cluster has. */
export const detectFeatures = (info: CiliumInfo | undefined, types: readonly ResourceType[]): Feature[] => {
  const config = info?.config;
  const kinds = new Set(types.map((type) => type.kind));
  const missing = (...required: string[]) => required.filter((kind) => !kinds.has(kind));

  const flag = (id: string, label: string, key: string, required: string[] = [], { defaultValue }: { defaultValue?: boolean } = {}): Feature => {
    const raw = config?.[key];
    const enabled = truthy(raw) ?? defaultValue;
    const missingTypes = missing(...required);
    const state: FeatureState = config === undefined ? (missingTypes.length === 0 && required.length > 0 ? "unknown" : "unknown") : enabled ? (missingTypes.length > 0 ? "disabled" : "enabled") : "disabled";

    return {
      id,
      label,
      state,
      detail: config === undefined ? "Agent configuration not readable" : raw === undefined ? `${key} not set${defaultValue !== undefined ? ` (default ${defaultValue ? "on" : "off"})` : ""}` : `${key}=${raw}`,
      missingTypes,
    };
  };

  const value = (id: string, label: string, keys: string[], fallback = "not set"): Feature => {
    const key = keys.find((candidate) => config?.[candidate] !== undefined);

    return {
      id,
      label,
      state: config === undefined ? "unknown" : key ? "enabled" : "disabled",
      detail: config === undefined ? "Agent configuration not readable" : key ? `${config[key]} (${key})` : fallback,
      missingTypes: [],
    };
  };

  const hubble = flag("hubble", "Hubble observability", "enable-hubble");
  const relayRunning = (info?.relays.length ?? 0) > 0;

  return [
    flag("gateway-api", "Gateway API", "enable-gateway-api", ["GatewayClass", "Gateway", "HTTPRoute"]),
    flag("ingress", "Ingress controller", "enable-ingress-controller"),
    flag("bgp", "BGP control plane", "enable-bgp-control-plane", kinds.has("CiliumBGPPeeringPolicy") && !kinds.has("CiliumBGPClusterConfig") ? ["CiliumBGPPeeringPolicy"] : ["CiliumBGPClusterConfig"]),
    flag("lb-ipam", "LoadBalancer IPAM", "enable-lb-ipam", ["CiliumLoadBalancerIPPool"], { defaultValue: true }),
    flag("l2-announcements", "L2 announcements", "enable-l2-announcements", ["CiliumL2AnnouncementPolicy"]),
    flag("egress-gateway", "Egress gateway", "enable-ipv4-egress-gateway", ["CiliumEgressGatewayPolicy"]),
    flag("envoy-config", "CiliumEnvoyConfig", "enable-envoy-config", ["CiliumEnvoyConfig"]),
    flag("l7-proxy", "L7 proxy", "enable-l7-proxy", [], { defaultValue: true }),
    flag("local-redirect", "Local redirect policies", "enable-local-redirect-policy", ["CiliumLocalRedirectPolicy"]),
    flag("endpoint-slices", "CiliumEndpointSlices", "enable-cilium-endpoint-slice", ["CiliumEndpointSlice"]),
    flag("host-firewall", "Host firewall", "enable-host-firewall"),
    flag("wireguard", "WireGuard encryption", "enable-wireguard"),
    flag("ipsec", "IPsec encryption", "enable-ipsec"),
    flag("ipv6", "IPv6", "enable-ipv6"),
    { ...hubble, detail: `${hubble.detail}${hubble.state === "enabled" ? (relayRunning ? "; Hubble Relay running" : "; no Hubble Relay pods found") : ""}` },
    value("policy-enforcement", "Policy enforcement mode", ["enable-policy"], "default"),
    value("kube-proxy-replacement", "kube-proxy replacement", ["kube-proxy-replacement"]),
    value("ipam", "IPAM mode", ["ipam"]),
    value("routing", "Routing mode", ["routing-mode", "tunnel-protocol", "tunnel"]),
    value("cluster-mesh", "Cluster name / id", ["cluster-name"]),
  ];
};

export const featureEnabled = (features: readonly Feature[], id: string) => features.find((feature) => feature.id === id)?.state === "enabled";
