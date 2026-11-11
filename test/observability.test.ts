import { describe, expect, it } from "vitest";
import type { CiliumInfo } from "../src/kube/cilium-info";
import { type KubectlClient, KubeError } from "../src/kube/kubectl";
import { jsonOutputUnsupported, parseAgentStatus, stateHealth, summarizeComponents } from "../src/observability/agent-status";
import {
  buildFlowFilter,
  emptyFilterForm,
  explainHubbleError,
  filterKey,
  flowKey,
  isHubbleTime,
  l7Summary,
  latestTime,
  mergeFlows,
  rcodeName,
  searchFlows,
  sortableTime,
} from "../src/observability/flow-logic";
import { dnsStats, flowsOfEndpoint, isDnsResponse, verdictStats, verdictTotals } from "../src/observability/flow-stats";
import { aggregateFlows, filterArgs, type Flow, observeFlows, parseFlowLine, parseFlows } from "../src/observability/hubble";
import { chartGeometry, formatMetric, niceMax, rangeFor, seriesColor, toChartSeries } from "../src/observability/metrics";
import { buildServiceMap, edgeColor, groupOf } from "../src/observability/service-map";

// Realistic `hubble observe --output jsonpb` lines, as Hubble 1.16 prints them.
const tcpForwarded = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:01.123456789Z",
    uuid: "2f1c-1",
    verdict: "FORWARDED",
    ethernet: { source: "aa", destination: "bb" },
    IP: { source: "10.0.1.15", destination: "10.0.2.20", ipVersion: "IPv4" },
    l4: { TCP: { source_port: 43122, destination_port: 8080, flags: { SYN: true } } },
    source: { ID: 1234, identity: 5678, namespace: "shop", labels: ["k8s:app=frontend", "k8s:io.kubernetes.pod.namespace=shop"], pod_name: "frontend-7d9f-abcde", workloads: [{ name: "frontend", kind: "Deployment" }] },
    destination: { ID: 2345, identity: 6789, namespace: "shop", labels: ["k8s:app=cart"], pod_name: "cart-5c8b-xyz12", workloads: [{ name: "cart", kind: "Deployment" }] },
    Type: "L3_L4",
    node_name: "kind-worker",
    event_type: { type: 4, sub_type: 3 },
    destination_service: { name: "cart", namespace: "shop" },
    traffic_direction: "EGRESS",
    trace_observation_point: "TO_ENDPOINT",
    is_reply: false,
    Summary: "TCP Flags: SYN",
  },
  node_name: "kind-worker",
  time: "2024-05-01T10:00:01.123456789Z",
});

const dropped = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:02Z",
    verdict: "DROPPED",
    drop_reason: 133,
    IP: { source: "10.0.1.15", destination: "10.0.3.9", ipVersion: "IPv4" },
    l4: { TCP: { source_port: 51000, destination_port: 5432, flags: { SYN: true } } },
    source: { identity: 5678, namespace: "shop", labels: ["k8s:app=frontend"], pod_name: "frontend-7d9f-abcde", workloads: [{ name: "frontend", kind: "Deployment" }] },
    destination: { identity: 7000, namespace: "db", labels: ["k8s:app=postgres"], pod_name: "postgres-0", workloads: [{ name: "postgres", kind: "StatefulSet" }] },
    Type: "L3_L4",
    node_name: "kind-worker",
    event_type: { type: 1, sub_type: 133 },
    traffic_direction: "EGRESS",
    drop_reason_desc: "POLICY_DENIED",
    Summary: "TCP Flags: SYN",
  },
  node_name: "kind-worker",
});

const policyVerdictDenied = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:02.5Z",
    verdict: "DROPPED",
    IP: { source: "10.0.1.15", destination: "10.0.3.9" },
    l4: { TCP: { source_port: 51000, destination_port: 5432 } },
    source: { identity: 5678, namespace: "shop", labels: ["k8s:app=frontend"], pod_name: "frontend-7d9f-abcde", workloads: [{ name: "frontend", kind: "Deployment" }] },
    destination: { identity: 7000, namespace: "db", labels: ["k8s:app=postgres"], pod_name: "postgres-0", workloads: [{ name: "postgres", kind: "StatefulSet" }] },
    Type: "L3_L4",
    node_name: "kind-worker2",
    event_type: { type: 5 },
    traffic_direction: "INGRESS",
    policy_match_type: 0,
    drop_reason_desc: "POLICY_DENIED",
    ingress_denied_by: [{ name: "deny-shop", namespace: "db", kind: "CiliumNetworkPolicy" }],
  },
});

const policyVerdictAllowed = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:03.000001Z",
    verdict: "FORWARDED",
    IP: { source: "10.0.1.16", destination: "10.0.3.9" },
    l4: { TCP: { source_port: 51500, destination_port: 5432 } },
    source: { identity: 5690, namespace: "shop", labels: ["k8s:app=orders"], pod_name: "orders-1", workloads: [{ name: "orders", kind: "Deployment" }] },
    destination: { identity: 7000, namespace: "db", labels: ["k8s:app=postgres"], pod_name: "postgres-0", workloads: [{ name: "postgres", kind: "StatefulSet" }] },
    Type: "L3_L4",
    node_name: "kind-worker2",
    event_type: { type: 5 },
    traffic_direction: "INGRESS",
    policy_match_type: 2,
    ingress_allowed_by: [{ name: "allow-orders", namespace: "db", kind: "CiliumNetworkPolicy" }],
  },
});

const dnsRequest = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:04.100Z",
    verdict: "FORWARDED",
    IP: { source: "10.0.1.15", destination: "10.0.0.10" },
    l4: { UDP: { source_port: 40000, destination_port: 53 } },
    source: { identity: 5678, namespace: "shop", labels: ["k8s:app=frontend"], pod_name: "frontend-7d9f-abcde", workloads: [{ name: "frontend", kind: "Deployment" }] },
    destination: { identity: 102, namespace: "kube-system", labels: ["k8s:k8s-app=kube-dns"], pod_name: "coredns-1", workloads: [{ name: "coredns", kind: "Deployment" }] },
    Type: "L7",
    node_name: "kind-worker",
    l7: { type: "REQUEST", dns: { query: "cart.shop.svc.cluster.local.", qtypes: ["A"], observation_source: "proxy" } },
    traffic_direction: "EGRESS",
    is_reply: false,
  },
});

const dnsResponse = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:04.102Z",
    verdict: "FORWARDED",
    IP: { source: "10.0.0.10", destination: "10.0.1.15" },
    l4: { UDP: { source_port: 53, destination_port: 40000 } },
    source: { identity: 102, namespace: "kube-system", labels: ["k8s:k8s-app=kube-dns"], pod_name: "coredns-1", workloads: [{ name: "coredns", kind: "Deployment" }] },
    destination: { identity: 5678, namespace: "shop", labels: ["k8s:app=frontend"], pod_name: "frontend-7d9f-abcde", workloads: [{ name: "frontend", kind: "Deployment" }] },
    Type: "L7",
    node_name: "kind-worker",
    l7: { type: "RESPONSE", latency_ns: "2000000", dns: { query: "cart.shop.svc.cluster.local.", ips: ["10.96.12.3"], ttl: 30, qtypes: ["A"], rrtypes: ["A"], observation_source: "proxy" } },
    traffic_direction: "EGRESS",
    is_reply: true,
  },
});

const dnsNxdomain = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:05Z",
    verdict: "FORWARDED",
    IP: { source: "10.0.0.10", destination: "10.0.1.15" },
    l4: { UDP: { source_port: 53, destination_port: 40001 } },
    source: { identity: 102, namespace: "kube-system", labels: ["k8s:k8s-app=kube-dns"], pod_name: "coredns-1", workloads: [{ name: "coredns", kind: "Deployment" }] },
    destination: { identity: 5678, namespace: "shop", labels: ["k8s:app=frontend"], pod_name: "frontend-7d9f-abcde", workloads: [{ name: "frontend", kind: "Deployment" }] },
    Type: "L7",
    node_name: "kind-worker",
    l7: { type: "RESPONSE", dns: { query: "nope.example.com.", rcode: 3, qtypes: ["AAAA"] } },
    is_reply: true,
  },
});

const httpResponse = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:06Z",
    verdict: "FORWARDED",
    IP: { source: "10.0.2.20", destination: "10.0.1.15" },
    l4: { TCP: { source_port: 8080, destination_port: 43122 } },
    source: { identity: 6789, namespace: "shop", labels: ["k8s:app=cart"], pod_name: "cart-5c8b-xyz12", workloads: [{ name: "cart", kind: "Deployment" }] },
    destination: { identity: 5678, namespace: "shop", labels: ["k8s:app=frontend"], pod_name: "frontend-7d9f-abcde", workloads: [{ name: "frontend", kind: "Deployment" }] },
    Type: "L7",
    node_name: "kind-worker",
    l7: { type: "RESPONSE", latency_ns: "12500000", http: { code: 503, method: "GET", url: "http://cart.shop:8080/api/items", protocol: "HTTP/1.1" } },
    is_reply: true,
  },
});

const world = JSON.stringify({
  flow: {
    time: "2024-05-01T10:00:07Z",
    verdict: "FORWARDED",
    IP: { source: "10.0.1.15", destination: "142.250.74.78" },
    l4: { TCP: { source_port: 50000, destination_port: 443 } },
    source: { identity: 5678, namespace: "shop", labels: ["k8s:app=frontend"], pod_name: "frontend-7d9f-abcde", workloads: [{ name: "frontend", kind: "Deployment" }] },
    destination: { identity: 2, labels: ["reserved:world"] },
    destination_names: ["google.com"],
    Type: "L3_L4",
    node_name: "kind-worker",
  },
});

const output = [tcpForwarded, dropped, policyVerdictDenied, policyVerdictAllowed, dnsRequest, dnsResponse, dnsNxdomain, httpResponse, world, "", "level=warning msg=\"something\"", "{not json"].join("\n");

describe("parsing hubble observe -o jsonpb", () => {
  const flows = parseFlows(output);

  it("parses every flow line and skips the rest", () => {
    expect(flows).toHaveLength(9);
  });

  it("reads L3/L4 flows", () => {
    const flow = flows[0];

    expect(flow).toMatchObject({ verdict: "FORWARDED", protocol: "TCP", type: "L3_L4", node: "kind-worker", direction: "EGRESS", uuid: "2f1c-1", tcpFlags: "SYN" });
    expect(flow.source).toMatchObject({ namespace: "shop", podName: "frontend-7d9f-abcde", workload: "Deployment/frontend", ip: "10.0.1.15", port: 43122, identity: 5678 });
    expect(flow.destination).toMatchObject({ port: 8080, service: "shop/cart" });
    expect(flow.raw).toBeUndefined();
  });

  it("reads drops with their reason", () => {
    expect(flows[1]).toMatchObject({ verdict: "DROPPED", dropReason: "POLICY_DENIED" });
  });

  it("reads policy verdicts and the policies that decided", () => {
    expect(flows[2].deniedBy).toEqual(["CiliumNetworkPolicy db/deny-shop"]);
    expect(flows[3].allowedBy).toEqual(["CiliumNetworkPolicy db/allow-orders"]);
    expect(flows[3].policyMatch).toBe("2");
  });

  it("reads DNS and HTTP at L7", () => {
    expect(flows[4]).toMatchObject({ protocol: "DNS", l7Type: "REQUEST", dns: { query: "cart.shop.svc.cluster.local.", qtypes: ["A"] } });
    expect(flows[5].dns?.ips).toEqual(["10.96.12.3"]);
    expect(flows[6].dns?.rcode).toBe(3);
    expect(flows[7]).toMatchObject({ protocol: "HTTP", http: { code: 503, method: "GET", latencyNs: 12500000 } });
  });

  it("keeps the raw flow only when asked", () => {
    expect(parseFlowLine(tcpForwarded, { keepRaw: true })?.raw?.uuid).toBe("2f1c-1");
    expect(parseFlows(tcpForwarded, { keepRaw: true })[0].raw).toBeDefined();
  });

  it("describes L7", () => {
    expect(l7Summary(flows[4])).toBe("DNS query cart.shop.svc.cluster.local. A");
    expect(l7Summary(flows[5])).toBe("DNS answer cart.shop.svc.cluster.local. A NOERROR → 10.96.12.3");
    expect(l7Summary(flows[6])).toContain("NXDOMAIN");
    expect(l7Summary(flows[7])).toBe("HTTP/1.1 GET http://cart.shop:8080/api/items → 503 (13ms)");
    expect(l7Summary(flows[0])).toBe("");
  });

  it("searches what the table shows", () => {
    expect(searchFlows(flows, "postgres")).toHaveLength(3);
    expect(searchFlows(flows, "google.com")).toHaveLength(1);
    expect(searchFlows(flows, "")).toHaveLength(9);
  });
});

describe("times, keys and follow merging", () => {
  const flows = parseFlows(output);

  it("sorts Hubble times with any number of fractional digits", () => {
    expect(sortableTime("2024-05-01T10:00:02Z")).toBe("2024-05-01T10:00:02.000000000Z");
    expect(sortableTime("2024-05-01T10:00:02Z") < sortableTime("2024-05-01T10:00:02.5Z")).toBe(true);
    expect(sortableTime("2024-05-01T10:00:02.5Z") < sortableTime("2024-05-01T10:00:03Z")).toBe(true);
  });

  it("finds the latest time as Hubble printed it", () => {
    expect(latestTime(flows)).toBe("2024-05-01T10:00:07Z");
    expect(latestTime([])).toBeUndefined();
  });

  it("merges without duplicates, oldest first, capped to the newest", () => {
    const first = flows.slice(0, 5);
    const second = flows.slice(3);
    const merged = mergeFlows(first, second, 100);

    expect(merged).toHaveLength(9);
    expect(new Set(merged.map(flowKey)).size).toBe(9);
    expect(merged[0].time).toBe("2024-05-01T10:00:01.123456789Z");

    const capped = mergeFlows(first, second, 3);

    expect(capped.map((flow) => flow.time)).toEqual(["2024-05-01T10:00:05Z", "2024-05-01T10:00:06Z", "2024-05-01T10:00:07Z"]);
  });

  it("keys flows by uuid when present", () => {
    expect(flowKey(flows[0])).toBe("2f1c-1");
    expect(flowKey(flows[1])).not.toBe(flowKey(flows[2]));
  });
});

describe("flow filter form", () => {
  it("defaults to the newest flows up to the limit", () => {
    expect(buildFlowFilter(emptyFilterForm, 500)).toEqual({ filter: { last: 500 }, errors: [] });
  });

  it("builds every hubble filter", () => {
    const { filter, errors } = buildFlowFilter({ ...emptyFilterForm, namespace: "shop", pod: "shop/frontend", labels: "app=web", verdict: "DROPPED", protocol: "TCP", port: "443", type: "drop", httpStatus: "5+", last: "50" }, 500);

    expect(errors).toEqual([]);
    expect(filter).toEqual({ last: 50, namespace: "shop", pod: "shop/frontend", labels: "app=web", verdict: "DROPPED", protocol: "tcp", port: 443, type: "drop", httpStatus: "5+" });
    expect(filterArgs(filter!)).toEqual(["--last", "50", "--namespace", "shop", "--pod", "shop/frontend", "--label", "app=web", "--verdict", "DROPPED", "--protocol", "tcp", "--port", "443", "--type", "drop", "--http-status", "5+"]);
  });

  it("builds a time range for historical flows", () => {
    expect(buildFlowFilter({ ...emptyFilterForm, timeMode: "range", since: "15m", until: "2024-05-01T10:00:00Z" }, 500).filter).toEqual({ since: "15m", until: "2024-05-01T10:00:00Z" });
  });

  it("caps the count at the flow limit", () => {
    expect(buildFlowFilter({ ...emptyFilterForm, last: "5000" }, 500).filter).toEqual({ last: 500 });
  });

  it("rejects what hubble would reject", () => {
    expect(buildFlowFilter({ ...emptyFilterForm, port: "70000" }, 500).errors).toHaveLength(1);
    expect(buildFlowFilter({ ...emptyFilterForm, timeMode: "range" }, 500).errors).toHaveLength(1);
    expect(buildFlowFilter({ ...emptyFilterForm, timeMode: "range", since: "yesterday" }, 500).errors).toHaveLength(1);
    expect(buildFlowFilter({ ...emptyFilterForm, httpStatus: "abc" }, 500).errors).toHaveLength(1);
    expect(isHubbleTime("90s")).toBe(true);
    expect(isHubbleTime("2024-05-01T10:00:00.5+02:00")).toBe(true);
  });

  it("keys filters regardless of field order", () => {
    expect(filterKey({ namespace: "a", last: 5 })).toBe(filterKey({ last: 5, namespace: "a" }));
  });
});

describe("aggregation and the service map", () => {
  const flows = parseFlows(output);

  it("aggregates flows into edges, ignoring replies", () => {
    const edges = aggregateFlows(flows);
    const toPostgres = edges.find((edge) => edge.from === "shop/frontend" && edge.to === "db/postgres");

    expect(toPostgres).toMatchObject({ dropped: 2, forwarded: 0, ports: ["5432/TCP"], dropReasons: ["POLICY_DENIED"] });
    expect(edges.some((edge) => edge.from === "kube-system/coredns")).toBe(false);
    expect(edges.find((edge) => edge.to === "world")).toBeDefined();
  });

  it("lays out namespaces as columns with world last", () => {
    const map = buildServiceMap(aggregateFlows(flows));

    expect(map.groups.map((group) => group.name)).toEqual(["db", "kube-system", "shop", "world"]);
    expect(map.nodes.find((node) => node.id === "world")?.x).toBe(3 * 280);
    expect(map.edges.find((edge) => edge.target === "db/postgres" && edge.source === "shop/frontend")?.color).toBe("critical");
    expect(buildServiceMap(aggregateFlows(flows))).toEqual(map);
  });

  it("keeps only the busiest nodes", () => {
    const map = buildServiceMap(aggregateFlows(flows), 2);

    expect(map.nodes).toHaveLength(2);
    expect(map.truncated).toBeGreaterThan(0);
    expect(map.edges.every((edge) => map.nodes.some((node) => node.id === edge.source) && map.nodes.some((node) => node.id === edge.target))).toBe(true);
  });

  it("colours edges by verdict", () => {
    expect(edgeColor({ forwarded: 3, dropped: 0 })).toBe("success");
    expect(edgeColor({ forwarded: 3, dropped: 1 })).toBe("warning");
    expect(edgeColor({ forwarded: 0, dropped: 1 })).toBe("critical");
    expect(groupOf({ labels: ["reserved:host"] })).toBe("cluster & host");
  });

  it("finds the flows of one endpoint", () => {
    expect(flowsOfEndpoint(flows, "db/postgres")).toHaveLength(3);
  });
});

describe("policy verdict stats", () => {
  const flows = parseFlows([policyVerdictDenied, policyVerdictDenied.replace("10:00:02.5Z", "10:00:09Z"), policyVerdictAllowed].join("\n"));

  it("groups by source, destination and port with the deciding policies", () => {
    const rows = verdictStats(flows);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "shop/frontend", destination: "db/postgres", port: "5432/TCP", direction: "INGRESS", denied: 2, allowed: 0, deniedBy: ["CiliumNetworkPolicy db/deny-shop"], dropReasons: ["POLICY_DENIED"], lastSeen: "2024-05-01T10:00:09Z" });
    expect(rows[1]).toMatchObject({ source: "shop/orders", allowed: 1, policies: ["CiliumNetworkPolicy db/allow-orders"] });
    expect(verdictTotals(rows)).toMatchObject({ allowed: 1, denied: 2, dropReasons: [{ value: "POLICY_DENIED", count: 2 }] });
  });
});

describe("DNS stats", () => {
  const flows = parseFlows(output);

  it("tells answers from queries", () => {
    expect(flows.filter((flow) => flow.dns).map(isDnsResponse)).toEqual([false, true, true]);
    // Without the L7 type, an answer is told by its direction or its content.
    expect(isDnsResponse({ ...flows[5], l7Type: undefined, isReply: undefined })).toBe(true);
    expect(isDnsResponse({ ...flows[4], l7Type: undefined })).toBe(false);
  });

  it("summarizes queries, codes, names and clients", () => {
    const stats = dnsStats(flows);

    expect(stats.total).toBe(3);
    expect(stats.queries.map((query) => [query.name, query.rcode, query.client])).toEqual([
      ["nope.example.com", "NXDOMAIN", "shop/frontend"],
      ["cart.shop.svc.cluster.local", "NOERROR", "shop/frontend"],
    ]);
    expect(stats.queries[1].ips).toEqual(["10.96.12.3"]);
    expect(stats.rcodes).toEqual([
      { value: "NOERROR", count: 1 },
      { value: "NXDOMAIN", count: 1 },
    ]);
    expect(stats.topNames).toEqual([{ value: "cart.shop.svc.cluster.local", count: 1 }]);
    expect(stats.failing).toEqual([{ value: "nope.example.com (NXDOMAIN)", count: 1 }]);
    expect(stats.byClient).toEqual([{ client: "shop/frontend", queries: 1, failures: 1, names: ["cart.shop.svc.cluster.local"] }]);
  });

  it("lists unanswered queries", () => {
    const stats = dnsStats(parseFlows(dnsRequest));

    expect(stats.queries).toHaveLength(1);
    expect(stats.queries[0].rcode).toBeUndefined();
  });

  it("names response codes", () => {
    expect(rcodeName(0)).toBe("NOERROR");
    expect(rcodeName(2)).toBe("SERVFAIL");
    expect(rcodeName(42)).toBe("RCODE42");
  });
});

describe("observeFlows", () => {
  const agent = { name: "cilium-abc", namespace: "kube-system", node: "kind-worker", ready: true, restarts: 0, containers: ["cilium-agent"] };
  const info: CiliumInfo = { namespace: "kube-system", agents: [agent], operators: [], relays: [{ ...agent, name: "hubble-relay-1", containers: ["hubble-relay"] }], envoys: [], config: { "enable-hubble": "true" } };
  const kubectl = (answer: (args: string[]) => string): KubectlClient & { calls: string[][] } => {
    const calls: string[][] = [];

    return { calls, run: async (args) => (calls.push(args), answer(args)), json: async () => ({}) as never };
  };

  it("reads the whole cluster through Relay", async () => {
    const client = kubectl(() => output);
    const result = await observeFlows(client, info, { last: 10 }, { keepRaw: true });

    expect(result.scope).toEqual({ kind: "relay", address: "hubble-relay.kube-system.svc.cluster.local:80" });
    expect(result.flows).toHaveLength(9);
    expect(result.flows[0].raw).toBeDefined();
    expect(client.calls[0]).toEqual(["exec", "cilium-abc", "--namespace", "kube-system", "--container", "cilium-agent", "--", "hubble", "observe", "--output", "jsonpb", "--last", "10", "--server", "hubble-relay.kube-system.svc.cluster.local:80"]);
  });

  it("falls back to one node when Relay does not answer, saying why", async () => {
    const client = kubectl((args) => {
      if (args.includes("--server")) throw new KubeError("Other", "rpc error: code = Unavailable");

      return tcpForwarded;
    });
    const result = await observeFlows(client, info, {});

    expect(result.scope.kind).toBe("node");
    expect(result.warnings[0]).toContain("did not answer");
  });

  it("refuses when Hubble is disabled", async () => {
    await expect(observeFlows(kubectl(() => ""), { ...info, config: { "enable-hubble": "false" } }, {})).rejects.toThrow(/hubble.enabled=true/);
  });
});

describe("explaining Hubble errors", () => {
  it("names the RBAC needed when exec is forbidden", () => {
    const problem = explainHubbleError(new KubeError("Forbidden", 'pods "cilium-abc" is forbidden: User "dev" cannot create resource "pods/exec"'));

    expect(problem.kind).toBe("rbac");
    expect(problem.detail).toContain("pods/exec");
  });

  it("recognizes a disabled Hubble server and a missing CLI", () => {
    expect(explainHubbleError(new KubeError("Other", "failed to connect to 'unix:///var/run/cilium/hubble.sock'")).kind).toBe("disabled");
    expect(explainHubbleError(new KubeError("Other", 'exec: "hubble": executable file not found in $PATH')).kind).toBe("cli");
    expect(explainHubbleError(new Error("boom")).kind).toBe("other");
  });
});

// What `cilium-dbg status -o json` prints on a node with a failing controller and a degraded cluster health.
const statusJson = {
  kvstore: { state: "Ok", msg: "Disabled" },
  kubernetes: { state: "Ok", msg: "1.30 (v1.30.0) [linux/amd64]", "k8s-api-versions": ["cilium/v2"] },
  cilium: { state: "Warning", msg: "1 controllers failing" },
  "container-runtime": { state: "Ok", msg: "" },
  stale: { "k8s-heartbeat": "2024-05-01T09:59:00Z" },
  ipam: { ipv4: ["10.0.1.0/24"], allocations: { "10.0.1.15": "shop/frontend", "10.0.1.16": "shop/orders", "10.0.1.200": "router" } },
  controllers: [
    { name: "sync-host-ips", status: { "consecutive-failure-count": 0, "failure-count": 0, "success-count": 120, "last-success-timestamp": "2024-05-01T10:00:00Z" } },
    { name: "endpoint-1234-regeneration-recovery", status: { "consecutive-failure-count": 4, "failure-count": 9, "last-failure-msg": "regeneration failed: BPF map full", "last-failure-timestamp": "2024-05-01T10:00:00Z" } },
  ],
  proxy: { ip: "10.0.1.1", "port-range": "10000-20000", "total-redirects": 2 },
  hubble: { state: "Ok", msg: "", observer: { "current-flows": 4095, "max-flows": 4095, "seen-flows": 120345, uptime: "2h3m" } },
  encryption: { mode: "Wireguard", msg: "" },
  "kube-proxy-replacement": { mode: "True", devices: [{ name: "eth0", ips: ["172.18.0.3"] }] },
  cluster: {
    ciliumHealth: { state: "Warning", msg: "1/3 nodes unreachable" },
    nodes: [{ name: "kind/kind-control-plane" }, { name: "kind/kind-worker" }, { name: "kind/kind-worker2" }],
    self: "kind/kind-worker",
  },
};

describe("cilium-dbg status -o json", () => {
  it("summarizes subsystems, controllers, health and features", () => {
    const summary = parseAgentStatus(statusJson);

    expect(summary.health).toBe("warn");
    expect(summary.checks.map((check) => [check.id, check.health])).toEqual([
      ["cilium", "warn"],
      ["kubernetes", "ok"],
      ["kvstore", "ok"],
      ["container-runtime", "ok"],
      ["hubble", "ok"],
    ]);
    expect(summary.controllers).toEqual({ total: 2, failing: [{ name: "endpoint-1234-regeneration-recovery", consecutiveFailures: 4, failures: 9, lastFailure: "regeneration failed: BPF map full", lastFailureAt: "2024-05-01T10:00:00Z" }] });
    expect(summary.clusterHealth).toMatchObject({ health: "warn", message: "1/3 nodes unreachable" });
    expect(summary.nodes).toHaveLength(3);
    expect(summary.self).toBe("kind/kind-worker");
    expect(summary.ipam).toEqual({ allocated: 3, detail: "1 IPv4" });
    expect(summary.hubble).toEqual({ currentFlows: 4095, maxFlows: 4095, seenFlows: 120345, uptime: "2h3m" });
    expect(summary.encryption).toBe("Wireguard");
    expect(summary.kubeProxyReplacement).toBe("True on eth0");
    expect(summary.stale).toEqual(["k8s-heartbeat"]);
    expect(summary.errors).toEqual([
      "Cilium: Warning — 1 controllers failing",
      "Cluster health: Warning — 1/3 nodes unreachable",
      "Controller endpoint-1234-regeneration-recovery failing 4×: regeneration failed: BPF map full",
      "Stale probe: k8s-heartbeat",
    ]);
  });

  it("reports a healthy agent as healthy and tolerates missing parts", () => {
    expect(parseAgentStatus({ cilium: { state: "Ok" }, kubernetes: { state: "Ok" } })).toMatchObject({ health: "ok", errors: [], nodes: [], controllers: { total: 0, failing: [] } });
    expect(parseAgentStatus({ cilium: { state: "Failure", msg: "daemon not ready" } }).health).toBe("error");
    expect(parseAgentStatus({}).health).toBe("ok");
    expect(stateHealth("Disabled")).toBe("unknown");
  });

  it("knows when to fall back to --brief", () => {
    expect(jsonOutputUnsupported("Error: unknown shorthand flag: 'o' in -o")).toBe(true);
    expect(jsonOutputUnsupported("Expected JSON, got: OK")).toBe(true);
    expect(jsonOutputUnsupported("connection refused")).toBe(false);
  });
});

describe("component versions", () => {
  const pod = (name: string, image: string, ready = true) => ({ name, namespace: "kube-system", node: "n1", ready, restarts: 1, image, containers: [] });

  it("flags agents and operators on different releases, ignoring envoy", () => {
    const summary = summarizeComponents({
      agents: [pod("cilium-a", "quay.io/cilium/cilium:v1.16.1@sha256:abc"), pod("cilium-b", "quay.io/cilium/cilium:v1.16.0", false)],
      operators: [pod("cilium-operator-1", "quay.io/cilium/operator-generic:v1.16.1")],
      relays: [pod("hubble-relay-1", "quay.io/cilium/hubble-relay:v1.16.1")],
      envoys: [pod("cilium-envoy-1", "quay.io/cilium/cilium-envoy:v1.29.7-abc")],
    });

    expect(summary.versions).toEqual(["v1.16.0", "v1.16.1"]);
    expect(summary.mixedVersions).toBe(true);
    expect(summary.notReady).toBe(1);
    expect(summary.restarts).toBe(5);
    expect(summary.pods.map((item) => item.component)).toEqual(["agent", "agent", "operator", "relay", "envoy"]);
  });
});

describe("metrics", () => {
  it("turns Prometheus series into chart series, dropping NaN and naming by label", () => {
    const series = toChartSeries(
      [
        { metric: { verdict: "FORWARDED" }, values: [[100, "5"], [115, "NaN"], [130, "7"]] },
        { metric: { verdict: "DROPPED" }, values: [[100, "1"]] },
        { metric: { verdict: "AUDIT" }, values: [[100, "NaN"]] },
      ],
      "verdict",
    );

    expect(series).toEqual([
      { name: "FORWARDED", points: [{ t: 100, v: 5 }, { t: 130, v: 7 }], latest: 7 },
      { name: "DROPPED", points: [{ t: 100, v: 1 }], latest: 1 },
    ]);
    expect(toChartSeries([{ metric: {}, values: [[1, "2"]] }])[0].name).toBe("total");
  });

  it("scales to a round maximum and breaks lines over gaps", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(0.22)).toBe(0.25);
    expect(niceMax(130)).toBe(200);

    const geometry = chartGeometry([{ name: "a", points: [{ t: 0, v: 0 }, { t: 10, v: 5 }, { t: 100, v: 10 }] }], { start: 0, end: 100, step: 10 }, 100, 50);

    expect(geometry.yMax).toBe(10);
    expect(geometry.ticks).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(geometry.paths[0].d).toBe("M0,50 L10,25 M100,0");
  });

  it("aligns ranges to their step", () => {
    expect(rangeFor("1h", 7230)).toEqual({ start: 3600, end: 7200, step: 60 });
  });

  it("formats values by unit and colours known series", () => {
    expect(formatMetric(1234, "per-second")).toBe("1.2k/s");
    expect(formatMetric(0.0123, "seconds")).toBe("12ms");
    expect(formatMetric(undefined, "count")).toBe("—");
    expect(seriesColor("DROPPED", 0)).toBe("var(--critical)");
    expect(seriesColor("x", 1)).toBe("var(--success)");
  });
});
