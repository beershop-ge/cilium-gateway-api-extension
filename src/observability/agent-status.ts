import type { Health } from "../common/conditions";
import type { Json } from "../common/json";
import { type AgentPod, type CiliumInfo, versionFromImage } from "../kube/cilium-info";

/** How the agent API names a subsystem's state, mapped to a health. */
export const stateHealth = (state: string | undefined): Health => {
  switch ((state ?? "").toLowerCase()) {
    case "ok":
      return "ok";
    case "warning":
      return "warn";
    case "failure":
    case "error":
      return "error";
    default:
      return "unknown";
  }
};

export interface StatusCheck {
  readonly id: string;
  readonly label: string;
  readonly health: Health;
  readonly state: string;
  readonly message?: string;
}

export interface FailingController {
  readonly name: string;
  readonly consecutiveFailures: number;
  readonly failures: number;
  readonly lastFailure?: string;
  readonly lastFailureAt?: string;
}

export interface AgentStatusSummary {
  readonly health: Health;
  readonly checks: readonly StatusCheck[];
  readonly controllers: { readonly total: number; readonly failing: readonly FailingController[] };
  readonly clusterHealth?: StatusCheck;
  readonly nodes: readonly string[];
  readonly self?: string;
  readonly ipam?: { readonly allocated: number; readonly detail?: string };
  readonly hubble?: { readonly currentFlows?: number; readonly maxFlows?: number; readonly seenFlows?: number; readonly uptime?: string };
  readonly encryption?: string;
  readonly kubeProxyReplacement?: string;
  readonly stale: readonly string[];
  readonly errors: readonly string[];
}

const subsystem = (status: Json, id: string, key: string, label: string): StatusCheck | undefined => {
  const value = status?.[key];

  if (!value || typeof value !== "object") return undefined;

  return { id, label, state: value.state ?? "Unknown", health: stateHealth(value.state), message: value.msg || undefined };
};

const worst = (healths: readonly Health[]): Health =>
  healths.includes("error") ? "error" : healths.includes("warn") ? "warn" : healths.includes("ok") ? "ok" : "unknown";

/** Reads what `cilium-dbg status -o json` prints (the agent's StatusResponse) into what to show per node. */
export const parseAgentStatus = (status: Json): AgentStatusSummary => {
  const checks = [
    subsystem(status, "cilium", "cilium", "Cilium"),
    subsystem(status, "kubernetes", "kubernetes", "Kubernetes"),
    subsystem(status, "kvstore", "kvstore", "KVStore"),
    subsystem(status, "container-runtime", "container-runtime", "Container runtime"),
    subsystem(status, "hubble", "hubble", "Hubble"),
    subsystem(status, "cluster-mesh", "cluster-mesh", "Cluster Mesh"),
    subsystem(status, "auth-certificate-provider", "auth-certificate-provider", "Auth certificate provider"),
    subsystem(status, "cni-chaining", "cni-chaining", "CNI chaining"),
  ].filter((check): check is StatusCheck => check !== undefined && !(check.id === "cluster-mesh" && check.state === "Unknown"));

  const controllers = ((status?.controllers ?? []) as Json[]).map((controller) => ({
    name: String(controller.name ?? ""),
    consecutiveFailures: Number(controller.status?.["consecutive-failure-count"] ?? 0),
    failures: Number(controller.status?.["failure-count"] ?? 0),
    lastFailure: controller.status?.["last-failure-msg"] || undefined,
    lastFailureAt: controller.status?.["last-failure-timestamp"] || undefined,
  }));
  const failing = controllers.filter((controller) => controller.consecutiveFailures > 0).sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || a.name.localeCompare(b.name));

  const clusterHealth = status?.cluster?.ciliumHealth
    ? { id: "cluster-health", label: "Cluster health", state: status.cluster.ciliumHealth.state ?? "Unknown", health: stateHealth(status.cluster.ciliumHealth.state), message: status.cluster.ciliumHealth.msg || undefined }
    : undefined;

  const ipam = status?.ipam;
  const allocations = ipam?.allocations && typeof ipam.allocations === "object" ? Object.keys(ipam.allocations).length : undefined;
  const ipv4 = Array.isArray(ipam?.ipv4) ? ipam.ipv4.length : undefined;
  const ipv6 = Array.isArray(ipam?.ipv6) ? ipam.ipv6.length : undefined;
  const ipamSummary =
    ipam && (allocations !== undefined || ipv4 !== undefined || ipv6 !== undefined)
      ? { allocated: allocations ?? (ipv4 ?? 0) + (ipv6 ?? 0), detail: [ipv4 !== undefined ? `${ipv4} IPv4` : undefined, ipv6 !== undefined ? `${ipv6} IPv6` : undefined].filter(Boolean).join(", ") || undefined }
      : undefined;

  const observer = status?.hubble?.observer;
  const encryptionMode = status?.encryption?.mode;
  const encryption = encryptionMode ? `${encryptionMode}${status.encryption.msg ? ` (${status.encryption.msg})` : ""}` : undefined;
  const kpr = status?.["kube-proxy-replacement"];
  const kubeProxyReplacement = kpr?.mode ? `${kpr.mode}${Array.isArray(kpr.devices) && kpr.devices.length > 0 ? ` on ${kpr.devices.map((device: Json) => device.name ?? device).join(", ")}` : ""}` : undefined;
  const stale = Object.keys(status?.stale ?? {});
  const errors = [
    ...checks.filter((check) => check.health === "error" || check.health === "warn").map((check) => `${check.label}: ${check.state}${check.message ? ` — ${check.message}` : ""}`),
    ...(clusterHealth && (clusterHealth.health === "error" || clusterHealth.health === "warn") ? [`Cluster health: ${clusterHealth.state}${clusterHealth.message ? ` — ${clusterHealth.message}` : ""}`] : []),
    ...failing.map((controller) => `Controller ${controller.name} failing ${controller.consecutiveFailures}×${controller.lastFailure ? `: ${controller.lastFailure}` : ""}`),
    ...stale.map((probe) => `Stale probe: ${probe}`),
  ];

  return {
    health: worst([...checks.map((check) => check.health), ...(clusterHealth ? [clusterHealth.health] : []), failing.length > 0 ? "warn" : "ok"]),
    checks,
    controllers: { total: controllers.length, failing },
    clusterHealth,
    nodes: ((status?.cluster?.nodes ?? []) as Json[]).map((node) => String(node.name ?? "")).filter(Boolean),
    self: status?.cluster?.self,
    ipam: ipamSummary,
    hubble: observer
      ? { currentFlows: observer["current-flows"], maxFlows: observer["max-flows"], seenFlows: observer["seen-flows"], uptime: observer.uptime }
      : undefined,
    encryption,
    kubeProxyReplacement,
    stale,
    errors,
  };
};

/** Whether the debug CLI rejected `-o json`, so the plain `--brief` status is the fallback. */
export const jsonOutputUnsupported = (message: string) => /unknown (shorthand )?flag|unknown command|invalid argument "json"|Expected JSON/i.test(message);

export interface ComponentPod extends AgentPod {
  readonly component: "agent" | "operator" | "relay" | "envoy";
  readonly version?: string;
}

export interface ComponentsSummary {
  readonly pods: readonly ComponentPod[];
  /** Versions of the agents, operators and relays, which should all be the same release. */
  readonly versions: readonly string[];
  readonly mixedVersions: boolean;
  readonly notReady: number;
  readonly restarts: number;
}

/** Every Cilium component pod with its version, flagging a cluster that runs more than one Cilium release. */
export const summarizeComponents = (info: CiliumInfo): ComponentsSummary => {
  const pods: ComponentPod[] = [
    ...info.agents.map((pod) => ({ ...pod, component: "agent" as const, version: versionFromImage(pod.image) })),
    ...info.operators.map((pod) => ({ ...pod, component: "operator" as const, version: versionFromImage(pod.image) })),
    ...info.relays.map((pod) => ({ ...pod, component: "relay" as const, version: versionFromImage(pod.image) })),
    ...info.envoys.map((pod) => ({ ...pod, component: "envoy" as const, version: versionFromImage(pod.image) })),
  ];
  // cilium-envoy is versioned by Envoy, and the relay may lag a patch; agents and operators must match.
  const versions = [...new Set(pods.filter((pod) => pod.component === "agent" || pod.component === "operator").map((pod) => pod.version).filter((version): version is string => Boolean(version)))].sort();

  return {
    pods,
    versions,
    mixedVersions: versions.length > 1,
    notReady: pods.filter((pod) => !pod.ready).length,
    restarts: pods.reduce((sum, pod) => sum + pod.restarts, 0),
  };
};
