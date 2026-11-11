import type { Json } from "../common/json";
import type { AgentPod, CiliumInfo } from "../kube/cilium-info";
import { execInAgent } from "../kube/cilium-exec";
import { KubeError, type KubectlClient } from "../kube/kubectl";

export type Verdict = "FORWARDED" | "DROPPED" | "ERROR" | "AUDIT" | "REDIRECTED" | "TRACED" | "TRANSLATED" | "UNKNOWN";

export interface FlowEndpoint {
  readonly namespace?: string;
  readonly podName?: string;
  readonly workload?: string;
  readonly identity?: number;
  readonly labels: readonly string[];
  readonly ip?: string;
  readonly port?: number;
  readonly service?: string;
  readonly names?: readonly string[];
}

export interface Flow {
  readonly time: string;
  readonly verdict: Verdict;
  readonly dropReason?: string;
  readonly source: FlowEndpoint;
  readonly destination: FlowEndpoint;
  readonly protocol: string;
  readonly direction?: string;
  readonly isReply?: boolean;
  readonly type: string;
  readonly node?: string;
  readonly summary?: string;
  readonly policyMatch?: string;
  readonly allowedBy?: readonly string[];
  readonly deniedBy?: readonly string[];
  readonly dns?: { readonly query?: string; readonly rcode?: number; readonly ips?: readonly string[]; readonly qtypes?: readonly string[]; readonly observationSource?: string };
  readonly http?: { readonly code?: number; readonly method?: string; readonly url?: string; readonly protocol?: string; readonly latencyNs?: number };
  readonly tcpFlags?: string;
  /** The flow's id, from Hubble 1.13 on. */
  readonly uuid?: string;
  /** REQUEST, RESPONSE or SAMPLE, for L7 flows. */
  readonly l7Type?: string;
  /** The flow as Hubble printed it, only when asked for with `keepRaw`. */
  readonly raw?: Json;
}

export interface FlowFilter {
  readonly last?: number;
  /** A duration hubble understands, such as `5m`, or an RFC 3339 time. */
  readonly since?: string;
  readonly until?: string;
  readonly namespace?: string;
  readonly pod?: string;
  readonly fromPod?: string;
  readonly toPod?: string;
  readonly labels?: string;
  readonly verdict?: Verdict;
  readonly protocol?: string;
  readonly port?: number;
  readonly type?: "l7" | "policy-verdict" | "drop" | "trace";
  readonly httpStatus?: string;
  readonly ip?: string;
  /** Read one node only, from its agent, instead of the whole cluster through Hubble Relay. */
  readonly node?: string;
}

export interface FlowResult {
  readonly flows: readonly Flow[];
  /** Where the flows came from: the whole cluster through Relay, or one node's agent. */
  readonly scope: { readonly kind: "relay"; readonly address: string } | { readonly kind: "node"; readonly node: string; readonly reason?: string };
  readonly warnings: readonly string[];
}

const workloadOf = (endpoint: Json): string | undefined => {
  const workload = (endpoint?.workloads ?? [])[0];

  return workload?.name ? `${workload.kind ?? "Workload"}/${workload.name}` : undefined;
};

const toEndpoint = (endpoint: Json, ip: string | undefined, port: number | undefined, service: Json): FlowEndpoint => ({
  namespace: endpoint?.namespace || undefined,
  podName: endpoint?.pod_name || undefined,
  workload: workloadOf(endpoint),
  identity: endpoint?.identity,
  labels: endpoint?.labels ?? [],
  ip,
  port,
  service: service?.name ? `${service.namespace ? `${service.namespace}/` : ""}${service.name}` : undefined,
});

const policyNames = (policies: Json[] | undefined) =>
  (policies ?? []).map((policy: Json) => `${policy.kind ?? "Policy"} ${policy.namespace ? `${policy.namespace}/` : ""}${policy.name}`);

/** Turns one line of `hubble observe --output jsonpb` into a flow. */
export const parseFlowLine = (line: string, { keepRaw = false }: { keepRaw?: boolean } = {}): Flow | undefined => {
  let parsed: Json;

  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  const flow = parsed?.flow;

  if (!flow) {
    return undefined;
  }

  const l4 = flow.l4 ?? {};
  const transport = l4.TCP ? "TCP" : l4.UDP ? "UDP" : l4.SCTP ? "SCTP" : l4.ICMPv4 ? "ICMPv4" : l4.ICMPv6 ? "ICMPv6" : "";
  const ports = l4.TCP ?? l4.UDP ?? l4.SCTP ?? {};
  const l7 = flow.l7;
  const protocol = l7?.dns ? "DNS" : l7?.http ? "HTTP" : l7?.kafka ? "Kafka" : transport || (flow.IP ? "IP" : "unknown");
  const tcpFlags = l4.TCP?.flags ? Object.entries(l4.TCP.flags).filter(([, set]) => set).map(([name]) => name).join(",") : undefined;

  return {
    time: flow.time ?? parsed.time,
    verdict: (flow.verdict ?? "UNKNOWN") as Verdict,
    dropReason: flow.drop_reason_desc && flow.drop_reason_desc !== "DROP_REASON_UNKNOWN" ? flow.drop_reason_desc : undefined,
    source: toEndpoint(flow.source, flow.IP?.source, ports.source_port, flow.source_service),
    destination: { ...toEndpoint(flow.destination, flow.IP?.destination, ports.destination_port, flow.destination_service), names: flow.destination_names },
    protocol,
    direction: flow.traffic_direction,
    isReply: flow.is_reply,
    type: flow.Type ?? flow.type ?? "",
    node: flow.node_name ?? parsed.node_name,
    summary: flow.Summary ?? flow.summary,
    policyMatch: flow.policy_match_type !== undefined ? String(flow.policy_match_type) : undefined,
    allowedBy: [...policyNames(flow.egress_allowed_by), ...policyNames(flow.ingress_allowed_by)],
    deniedBy: [...policyNames(flow.egress_denied_by), ...policyNames(flow.ingress_denied_by)],
    dns: l7?.dns
      ? { query: l7.dns.query, rcode: l7.dns.rcode, ips: l7.dns.ips, qtypes: l7.dns.qtypes, observationSource: l7.dns.observation_source }
      : undefined,
    http: l7?.http ? { code: l7.http.code, method: l7.http.method, url: l7.http.url, protocol: l7.http.protocol, latencyNs: l7.latency_ns ? Number(l7.latency_ns) : undefined } : undefined,
    tcpFlags,
    uuid: flow.uuid || undefined,
    l7Type: l7?.type || undefined,
    ...(keepRaw ? { raw: flow } : {}),
  };
};

export const parseFlows = (output: string, options: { keepRaw?: boolean } = {}): Flow[] =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => parseFlowLine(line, options))
    .filter((flow): flow is Flow => flow !== undefined);

export const filterArgs = (filter: FlowFilter): string[] => {
  const args: string[] = [];

  if (filter.since) args.push("--since", filter.since);
  if (filter.until) args.push("--until", filter.until);
  if (!filter.since && !filter.until) args.push("--last", String(filter.last ?? 500));
  else if (filter.last) args.push("--last", String(filter.last));
  if (filter.namespace) args.push("--namespace", filter.namespace);
  if (filter.pod) args.push("--pod", filter.pod);
  if (filter.fromPod) args.push("--from-pod", filter.fromPod);
  if (filter.toPod) args.push("--to-pod", filter.toPod);
  if (filter.labels) args.push("--label", filter.labels);
  if (filter.verdict) args.push("--verdict", filter.verdict);
  if (filter.protocol) args.push("--protocol", filter.protocol);
  if (filter.port) args.push("--port", String(filter.port));
  if (filter.type) args.push("--type", filter.type);
  if (filter.httpStatus) args.push("--http-status", filter.httpStatus);
  if (filter.ip) args.push("--ip", filter.ip);

  return args;
};

export const relayAddressOf = (info: CiliumInfo, override?: string) => {
  if (override) {
    return override;
  }

  const relay = info.relays[0];

  return relay ? `hubble-relay.${relay.namespace}.svc.cluster.local:80` : undefined;
};

/** Whether Hubble is enabled in the agent configuration, as far as it can be read. */
export const hubbleStatus = (info: CiliumInfo | undefined): { readonly available: boolean; readonly reason?: string } => {
  if (!info) return { available: false, reason: "Cilium has not been read yet" };
  if (info.agents.length === 0) return { available: false, reason: info.podsError ? `Cannot list Cilium agent pods: ${info.podsError}` : "No Cilium agent pods were found (label k8s-app=cilium)" };
  if (info.config && info.config["enable-hubble"] !== undefined && info.config["enable-hubble"] !== "true") {
    return { available: false, reason: "Hubble is disabled in the agent configuration (enable-hubble=false). Enable it with the Helm value hubble.enabled=true." };
  }

  return { available: true };
};

const pickAgent = (info: CiliumInfo, node?: string): AgentPod | undefined =>
  (node ? info.agents.find((agent) => agent.node === node) : undefined) ?? info.agents.find((agent) => agent.ready) ?? info.agents[0];

/**
 * Reads flows with the `hubble` CLI that ships in every Cilium agent, through `kubectl exec` as the user:
 * from Hubble Relay for the whole cluster when it runs, else from one node's agent. Needs `pods/exec`
 * on the agent pods; nothing is installed and no port is opened.
 */
export const observeFlows = async (kubectl: KubectlClient, info: CiliumInfo, filter: FlowFilter, { relayOverride, signal, keepRaw }: { relayOverride?: string; signal?: AbortSignal; keepRaw?: boolean } = {}): Promise<FlowResult> => {
  const status = hubbleStatus(info);

  if (!status.available) {
    throw new KubeError("NotServed", status.reason ?? "Hubble is not available");
  }

  const agent = pickAgent(info, filter.node);

  if (!agent) {
    throw new KubeError("NotServed", "No Cilium agent pod to run hubble in");
  }

  const args = ["hubble", "observe", "--output", "jsonpb", ...filterArgs(filter)];
  const warnings: string[] = [];
  const relay = filter.node ? undefined : relayAddressOf(info, relayOverride);

  if (relay) {
    try {
      const output = await execInAgent(kubectl, agent, [...args, "--server", relay], { timeoutMs: 60_000, signal });

      return { flows: parseFlows(output, { keepRaw }), scope: { kind: "relay", address: relay }, warnings };
    } catch (error) {
      if (error instanceof KubeError && (error.kind === "Forbidden" || error.kind === "Aborted")) {
        throw error;
      }

      warnings.push(`Hubble Relay at ${relay} did not answer (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); showing the flows of node ${agent.node ?? agent.name} only.`);
    }
  } else if (!filter.node) {
    warnings.push("No Hubble Relay runs in this cluster, so only one node's flows are shown. Enable it with the Helm value hubble.relay.enabled=true.");
  }

  const output = await execInAgent(kubectl, agent, args, { timeoutMs: 60_000, signal });

  return { flows: parseFlows(output, { keepRaw }), scope: { kind: "node", node: agent.node ?? agent.name, reason: warnings[0] }, warnings };
};

/** A name for an endpoint that is stable across pod restarts: its workload, else its pod, else its reserved identity or IP. */
export const endpointName = (endpoint: FlowEndpoint): string => {
  if (endpoint.workload) return `${endpoint.namespace}/${endpoint.workload.split("/")[1]}`;
  if (endpoint.podName) return `${endpoint.namespace}/${endpoint.podName}`;

  const reserved = endpoint.labels.find((label) => label.startsWith("reserved:"));

  if (reserved) return reserved.replace("reserved:", "");
  if (endpoint.names?.length) return endpoint.names[0];

  return endpoint.ip ?? "unknown";
};

export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly fromEndpoint: FlowEndpoint;
  readonly toEndpoint: FlowEndpoint;
  readonly forwarded: number;
  readonly dropped: number;
  readonly other: number;
  readonly ports: readonly string[];
  readonly protocols: readonly string[];
  readonly dropReasons: readonly string[];
  readonly lastSeen: string;
}

/** Groups flows into edges between endpoints, counting verdicts, ignoring replies. */
export const aggregateFlows = (flows: readonly Flow[]): FlowEdge[] => {
  const edges = new Map<string, { from: string; to: string; fromEndpoint: FlowEndpoint; toEndpoint: FlowEndpoint; forwarded: number; dropped: number; other: number; ports: Set<string>; protocols: Set<string>; dropReasons: Set<string>; lastSeen: string }>();

  for (const flow of flows) {
    if (flow.isReply) {
      continue;
    }

    const from = endpointName(flow.source);
    const to = endpointName(flow.destination);
    const key = `${from}→${to}`;
    let edge = edges.get(key);

    if (!edge) {
      edge = { from, to, fromEndpoint: flow.source, toEndpoint: flow.destination, forwarded: 0, dropped: 0, other: 0, ports: new Set(), protocols: new Set(), dropReasons: new Set(), lastSeen: flow.time };
      edges.set(key, edge);
    }

    if (flow.verdict === "FORWARDED" || flow.verdict === "REDIRECTED" || flow.verdict === "TRANSLATED") edge.forwarded++;
    else if (flow.verdict === "DROPPED" || flow.verdict === "ERROR") edge.dropped++;
    else edge.other++;

    if (flow.destination.port) edge.ports.add(`${flow.destination.port}/${flow.protocol === "DNS" || flow.protocol === "HTTP" ? (flow.protocol === "DNS" ? "UDP" : "TCP") : flow.protocol}`);
    edge.protocols.add(flow.protocol);
    if (flow.dropReason) edge.dropReasons.add(flow.dropReason);
    if (flow.time > edge.lastSeen) edge.lastSeen = flow.time;
  }

  return [...edges.values()].map((edge) => ({ ...edge, ports: [...edge.ports], protocols: [...edge.protocols], dropReasons: [...edge.dropReasons] }));
};
