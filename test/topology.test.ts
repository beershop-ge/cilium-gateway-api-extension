import { describe, expect, it } from "vitest";
import type { Flow } from "../src/observability/hubble";
import { graphToSvg } from "../src/topology/export-svg";
import { applyFilter, connectedPath, filterByLayers, filterByNamespaces, namespaceCounts, searchNodes } from "../src/topology/filter";
import { buildGraph, type Graph, nodeId, podHealth } from "../src/topology/graph";
import { layoutGraph } from "../src/topology/layout";
import { computeView } from "../src/topology/model";
import { observedTraffic, verdictOf } from "../src/topology/traffic";

const meta = (name: string, namespace?: string, extra: Record<string, unknown> = {}) => ({ metadata: { name, ...(namespace ? { namespace } : {}), ...extra } });

const readyPod = (name: string, namespace: string, labels: Record<string, string>, node = "node-a") => ({
  ...meta(name, namespace, { labels }),
  spec: { nodeName: node, serviceAccountName: "default" },
  status: { phase: "Running", podIP: "10.0.0.1", containerStatuses: [{ name: "app", ready: true, restartCount: 0 }] },
});

const fixture = () => ({
  namespaces: [meta("shop", undefined, { labels: { team: "a" } }), meta("other")],
  nodes: [
    { ...meta("node-a", undefined, { labels: { "egress-node": "true", bgp: "yes" } }), status: { conditions: [{ type: "Ready", status: "True" }] } },
    { ...meta("node-b"), status: { conditions: [{ type: "Ready", status: "False", reason: "KubeletNotReady" }] } },
  ],
  pods: [
    readyPod("web-1", "shop", { app: "web" }),
    { ...readyPod("web-2", "shop", { app: "web" }, "node-b"), status: { phase: "Running", containerStatuses: [{ name: "app", ready: false, state: { waiting: { reason: "CrashLoopBackOff" } } }] } },
    readyPod("db-1", "other", { app: "db" }),
  ],
  services: [
    { ...meta("web", "shop", { labels: { advertise: "bgp" } }), spec: { type: "LoadBalancer", clusterIP: "10.96.0.10", selector: { app: "web" }, ports: [{ port: 80, targetPort: 8080 }] }, status: { loadBalancer: { ingress: [{ ip: "192.168.1.10" }] } } },
    { ...meta("cilium-gateway-gw", "shop", { labels: { "io.cilium.gateway/owning-gateway": "gw" } }), spec: { type: "LoadBalancer", clusterIP: "10.96.0.11" }, status: { loadBalancer: { ingress: [{ ip: "192.168.1.11" }] } } },
    { ...meta("db", "other"), spec: { type: "ClusterIP", clusterIP: "10.96.0.12", selector: { app: "db" } } },
  ],
  "endpointslices.discovery.k8s.io": [
    {
      ...meta("web-abc", "shop", { labels: { "kubernetes.io/service-name": "web" } }),
      ports: [{ port: 8080, protocol: "TCP" }],
      endpoints: [
        { addresses: ["10.0.0.1"], conditions: { ready: true }, targetRef: { kind: "Pod", name: "web-1", namespace: "shop" }, nodeName: "node-a" },
        { addresses: ["10.0.0.2"], conditions: { ready: false }, targetRef: { kind: "Pod", name: "web-2", namespace: "shop" }, nodeName: "node-b" },
      ],
    },
    {
      ...meta("web-v6", "shop", { labels: { "kubernetes.io/service-name": "web" } }),
      endpoints: [{ addresses: ["fd00::1"], conditions: { ready: true }, targetRef: { kind: "Pod", name: "web-1", namespace: "shop" } }],
    },
  ],
  "networkpolicies.networking.k8s.io": [{ ...meta("deny-all", "other"), spec: { podSelector: {}, policyTypes: ["Ingress"] } }],
  Gateway: [
    {
      ...meta("gw", "shop", { uid: "gw-uid" }),
      spec: { gatewayClassName: "cilium", listeners: [{ name: "http", protocol: "HTTP", port: 80 }, { name: "https", protocol: "HTTPS", port: 443 }] },
      status: {
        addresses: [{ value: "192.168.1.11" }],
        conditions: [{ type: "Accepted", status: "True" }, { type: "Programmed", status: "True" }],
        listeners: [{ name: "http", attachedRoutes: 1, conditions: [{ type: "Accepted", status: "True" }, { type: "Programmed", status: "True" }, { type: "ResolvedRefs", status: "True" }] }],
      },
    },
  ],
  HTTPRoute: [
    {
      ...meta("web-route", "shop"),
      spec: { parentRefs: [{ name: "gw", sectionName: "http" }], rules: [{ backendRefs: [{ name: "web", port: 80 }, { name: "ghost", port: 80 }] }] },
      status: { parents: [{ parentRef: { name: "gw", sectionName: "http" }, conditions: [{ type: "Accepted", status: "True" }, { type: "ResolvedRefs", status: "False", reason: "BackendNotFound" }] }] },
    },
  ],
  CiliumEndpoint: [{ ...meta("web-1", "shop"), status: { id: 42, state: "ready", identity: { id: 12345, labels: ["k8s:app=web", "k8s:io.kubernetes.pod.namespace=shop"] } } }],
  CiliumIdentity: [{ ...meta("12345"), "security-labels": { "k8s:app": "web" } }],
  CiliumNetworkPolicy: [{ ...meta("allow-web", "shop"), spec: { endpointSelector: { matchLabels: { "k8s:app": "web" } }, ingress: [{}] } }],
  CiliumClusterwideNetworkPolicy: [{ ...meta("host-fw"), spec: { nodeSelector: { matchLabels: { bgp: "yes" } }, ingress: [{}] } }],
  CiliumLoadBalancerIPPool: [
    { ...meta("pool"), spec: { blocks: [{ cidr: "192.168.1.0/28" }] }, status: { conditions: [{ type: "cilium.io/PoolConflict", status: "False" }] } },
    { ...meta("unused"), spec: { blocks: [{ start: "10.10.0.1", stop: "10.10.0.9" }] } },
  ],
  CiliumL2AnnouncementPolicy: [{ ...meta("l2"), spec: { serviceSelector: { matchLabels: { advertise: "bgp" } }, loadBalancerIPs: true } }],
  CiliumEgressGatewayPolicy: [{ ...meta("egress"), spec: { selectors: [{ podSelector: { matchLabels: { app: "db", "io.kubernetes.pod.namespace": "other" } } }], destinationCIDRs: ["0.0.0.0/0"], egressGateway: { nodeSelector: { matchLabels: { "egress-node": "true" } } } } }],
  CiliumEnvoyConfig: [{ ...meta("cilium-gateway-gw", "shop", { ownerReferences: [{ kind: "Gateway", name: "gw", uid: "gw-uid" }] }), spec: { services: [{ name: "cilium-gateway-gw", namespace: "shop" }], backendServices: [{ name: "web", namespace: "shop" }], resources: [{}] } }],
  CiliumBGPClusterConfig: [
    { ...meta("bgp"), spec: { nodeSelector: { matchLabels: { bgp: "yes" } }, bgpInstances: [{ name: "i1", localASN: 65001, peers: [{ name: "tor", peerAddress: "10.1.0.1", peerASN: 65000, peerConfigRef: { name: "peer-cfg" } }, { name: "tor2", peerASN: 65000, peerConfigRef: { name: "missing-cfg" } }] }] } },
  ],
  CiliumBGPPeerConfig: [{ ...meta("peer-cfg"), spec: { families: [{ afi: "ipv4", safi: "unicast", advertisements: { matchLabels: { advertise: "bgp" } } }] } }],
  CiliumBGPAdvertisement: [{ ...meta("adv", undefined, { labels: { advertise: "bgp" } }), spec: { advertisements: [{ advertisementType: "Service", service: { addresses: ["LoadBalancerIP"] }, selector: { matchLabels: { advertise: "bgp" } } }, { advertisementType: "PodCIDR" }] } }],
  CiliumBGPNodeConfig: [{ ...meta("node-a"), status: { bgpInstances: [{ name: "i1", peers: [{ name: "tor", peeringState: "established" }, { name: "tor2", peeringState: "active" }] }] } }],
});

const edgeIds = (graph: Graph) => new Set(graph.edges.map((edge) => edge.id));
const nodeOf = (graph: Graph, id: string) => graph.nodes.find((node) => node.id === id);

describe("topology graph builder", () => {
  const graph = buildGraph({ items: fixture() });
  const edges = edgeIds(graph);

  it("follows Internet → Gateway → Listener → Route → Service → Endpoint → Pod → Node", () => {
    expect(edges).toContain(`internet->${nodeId.gateway("shop", "gw")}`);
    expect(edges).toContain(`${nodeId.gateway("shop", "gw")}->${nodeId.listener("shop", "gw", "http")}`);
    expect(edges).toContain(`${nodeId.listener("shop", "gw", "http")}->${nodeId.route("HTTPRoute", "shop", "web-route")}`);
    expect(edges).not.toContain(`${nodeId.listener("shop", "gw", "https")}->${nodeId.route("HTTPRoute", "shop", "web-route")}`);
    expect(edges).toContain(`${nodeId.route("HTTPRoute", "shop", "web-route")}->${nodeId.service("shop", "web")}`);
    expect(edges).toContain(`${nodeId.service("shop", "web")}->${nodeId.endpoint("shop", "web", "Pod/web-1")}`);
    expect(edges).toContain(`${nodeId.endpoint("shop", "web", "Pod/web-1")}->${nodeId.pod("shop", "web-1")}`);
    expect(edges).toContain(`${nodeId.pod("shop", "web-1")}->${nodeId.node("node-a")}`);
  });

  it("merges dual-stack endpoints of the same pod and reports service readiness", () => {
    expect(graph.nodes.filter((node) => node.layer === "endpoint")).toHaveLength(2);
    expect(nodeOf(graph, nodeId.endpoint("shop", "web", "Pod/web-1"))!.facts).toContainEqual(["Addresses", "10.0.0.1, fd00::1"]);
    expect(nodeOf(graph, nodeId.service("shop", "web"))).toMatchObject({ health: "warn", healthReason: "1 of 2 endpoints ready" });
    expect(nodeOf(graph, nodeId.service("other", "db"))).toMatchObject({ health: "warn" });
  });

  it("marks referenced but missing resources, and health from conditions", () => {
    expect(nodeOf(graph, nodeId.service("shop", "ghost"))).toMatchObject({ missing: true, health: "error" });
    expect(nodeOf(graph, nodeId.route("HTTPRoute", "shop", "web-route"))!.health).toBe("error");
    expect(nodeOf(graph, nodeId.listener("shop", "gw", "https"))!.health).toBe("unknown");
    expect(nodeOf(graph, nodeId.node("node-b"))!.health).toBe("error");
    expect(nodeOf(graph, nodeId.pod("shop", "web-2"))!.health).toBe("error");
    expect(nodeOf(graph, nodeId.bgpPeerConfig("missing-cfg"))).toMatchObject({ missing: true, health: "error" });
  });

  it("does not link the Internet to a Gateway's own Service, but links it to other LoadBalancers", () => {
    expect(edges).toContain(`internet->${nodeId.service("shop", "web")}`);
    expect(edges).not.toContain(`internet->${nodeId.service("shop", "cilium-gateway-gw")}`);
    expect(edges).toContain(`${nodeId.gateway("shop", "gw")}->${nodeId.service("shop", "cilium-gateway-gw")}`);
  });

  it("links policies to the pods their selectors match, in their namespace only", () => {
    expect(edges).toContain(`${nodeId.pod("shop", "web-1")}->${nodeId.policy("CiliumNetworkPolicy", "shop", "allow-web")}`);
    expect(edges).toContain(`${nodeId.pod("shop", "web-2")}->${nodeId.policy("CiliumNetworkPolicy", "shop", "allow-web")}`);
    expect(edges).not.toContain(`${nodeId.pod("other", "db-1")}->${nodeId.policy("CiliumNetworkPolicy", "shop", "allow-web")}`);
    expect(edges).toContain(`${nodeId.pod("other", "db-1")}->${nodeId.policy("NetworkPolicy", "other", "deny-all")}`);
    expect(edges).not.toContain(`${nodeId.pod("shop", "web-1")}->${nodeId.policy("NetworkPolicy", "other", "deny-all")}`);
    expect(edges).toContain(`${nodeId.policy("CiliumClusterwideNetworkPolicy", undefined, "host-fw")}->${nodeId.node("node-a")}`);
  });

  it("links identities, pools, L2, egress, Envoy and BGP only where the resources say so", () => {
    expect(edges).toContain(`${nodeId.pod("shop", "web-1")}->${nodeId.identity(12345)}`);
    expect(nodeOf(graph, nodeId.identity(12345))!.ref).toMatchObject({ kind: "CiliumIdentity", name: "12345" });
    expect(edges).toContain(`${nodeId.pool("pool")}->${nodeId.service("shop", "web")}`);
    expect(edges).toContain(`${nodeId.pool("pool")}->${nodeId.service("shop", "cilium-gateway-gw")}`);
    expect(graph.edges.some((edge) => edge.from === nodeId.pool("unused"))).toBe(false);
    expect(edges).toContain(`${nodeId.l2("l2")}->${nodeId.service("shop", "web")}`);
    expect(edges).not.toContain(`${nodeId.l2("l2")}->${nodeId.service("other", "db")}`);
    expect(edges).toContain(`${nodeId.pod("other", "db-1")}->${nodeId.egress("egress")}`);
    expect(edges).toContain(`${nodeId.egress("egress")}->${nodeId.node("node-a")}`);
    expect(edges).not.toContain(`${nodeId.egress("egress")}->${nodeId.node("node-b")}`);
    expect(edges).toContain(`${nodeId.envoy("CiliumEnvoyConfig", "shop", "cilium-gateway-gw")}->${nodeId.service("shop", "web")}`);
    expect(edges).toContain(`${nodeId.gateway("shop", "gw")}->${nodeId.envoy("CiliumEnvoyConfig", "shop", "cilium-gateway-gw")}`);

    const cluster = nodeId.bgpCluster("CiliumBGPClusterConfig", "bgp");
    const peer = nodeId.bgpPeer("bgp", "i1", "tor");

    expect(edges).toContain(`${cluster}->${peer}`);
    expect(edges).toContain(`${peer}->${nodeId.bgpPeerConfig("peer-cfg")}`);
    expect(edges).toContain(`${nodeId.bgpPeerConfig("peer-cfg")}->${nodeId.bgpAdvertisement("adv")}`);
    expect(edges).toContain(`${nodeId.bgpAdvertisement("adv")}->${nodeId.service("shop", "web")}`);
    expect(edges).not.toContain(`${nodeId.bgpAdvertisement("adv")}->${nodeId.service("other", "db")}`);
    expect(edges).toContain(`${cluster}->${nodeId.node("node-a")}`);
    expect(edges).not.toContain(`${cluster}->${nodeId.node("node-b")}`);
    expect(nodeOf(graph, peer)!.health).toBe("ok");
    expect(nodeOf(graph, nodeId.bgpPeer("bgp", "i1", "tor2"))!.health).toBe("error");
  });

  it("points every configured edge rightwards, so the layered layout reads left to right", () => {
    const columnOf = new Map(graph.nodes.map((node) => [node.id, node.column]));

    for (const edge of graph.edges) expect(columnOf.get(edge.from)!, edge.id).toBeLessThan(columnOf.get(edge.to)!);
  });

  it("reports health as unknown when what it depends on could not be read", () => {
    const partial = buildGraph({ items: { ...fixture(), "endpointslices.discovery.k8s.io": [] }, unavailable: ["endpointslices.discovery.k8s.io"] });

    expect(nodeOf(partial, nodeId.service("other", "db"))!.health).toBe("unknown");
  });

  it("returns an empty graph for an empty cluster", () => {
    expect(buildGraph({ items: {} })).toEqual({ nodes: [], edges: [] });
  });

  it("derives pod health from phase and containers", () => {
    expect(podHealth({ status: { phase: "Pending" } }).health).toBe("warn");
    expect(podHealth({ status: { phase: "Succeeded" } }).health).toBe("ok");
    expect(podHealth({ status: { phase: "Running", containerStatuses: [{ name: "a", ready: false, state: { waiting: { reason: "ImagePullBackOff" } } }] } }).health).toBe("error");
  });
});

describe("topology filters and paths", () => {
  const graph = buildGraph({ items: fixture() });

  it("keeps a namespace's nodes and the cluster-scoped nodes connected to them", () => {
    const shop = filterByNamespaces(graph, ["shop"]);
    const ids = new Set(shop.nodes.map((node) => node.id));

    expect(ids.has(nodeId.pod("other", "db-1"))).toBe(false);
    expect(ids.has(nodeId.pod("shop", "web-1"))).toBe(true);
    expect(ids.has(nodeId.pool("pool"))).toBe(true);
    expect(ids.has(nodeId.bgpPeer("bgp", "i1", "tor"))).toBe(true);
    expect(ids.has(nodeId.node("node-a"))).toBe(true);
    expect(ids.has(nodeId.pool("unused"))).toBe(false);
    expect(ids.has(nodeId.policy("NetworkPolicy", "other", "deny-all"))).toBe(false);
    expect(shop.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
  });

  it("bridges hidden endpoints so Service → Pod remains, without bridging configuration edges", () => {
    const hidden = filterByLayers(graph, ["endpoint"]);
    const bridged = hidden.edges.find((edge) => edge.id === `${nodeId.service("shop", "web")}->${nodeId.pod("shop", "web-1")}`);

    expect(hidden.nodes.some((node) => node.layer === "endpoint")).toBe(false);
    expect(bridged).toMatchObject({ via: "Endpoint", relation: "path" });

    const noPods = filterByLayers(graph, ["pod"]);

    expect(noPods.edges.some((edge) => edge.to.startsWith("policy:") || edge.to.startsWith("node:") && edge.from.startsWith("endpoint:"))).toBe(false);
  });

  it("bridges a chain of hidden layers", () => {
    const hidden = filterByLayers(graph, ["listener", "route"]);

    expect(hidden.edges.map((edge) => edge.id)).toContain(`${nodeId.gateway("shop", "gw")}->${nodeId.service("shop", "web")}`);
  });

  it("highlights everything upstream and downstream of a node, and nothing beside it", () => {
    const path = connectedPath(graph.edges, nodeId.route("HTTPRoute", "shop", "web-route"));

    expect(path.nodes.has(nodeId.internet)).toBe(true);
    expect(path.nodes.has(nodeId.listener("shop", "gw", "http"))).toBe(true);
    expect(path.nodes.has(nodeId.pod("shop", "web-1"))).toBe(true);
    expect(path.nodes.has(nodeId.node("node-a"))).toBe(true);
    expect(path.nodes.has(nodeId.listener("shop", "gw", "https"))).toBe(false);
    expect(path.nodes.has(nodeId.pod("other", "db-1"))).toBe(false);
    expect(path.edges.has(`${nodeId.gateway("shop", "gw")}->${nodeId.listener("shop", "gw", "http")}`)).toBe(true);
    expect(path.edges.has(`${nodeId.gateway("shop", "gw")}->${nodeId.listener("shop", "gw", "https")}`)).toBe(false);
  });

  it("searches by every word and counts namespaces", () => {
    expect(searchNodes(graph.nodes, "allow WEB").map((node) => node.id)).toEqual([nodeId.policy("CiliumNetworkPolicy", "shop", "allow-web")]);
    expect(searchNodes(graph.nodes, "  ")).toEqual([]);
    expect(namespaceCounts(graph)[0].namespace).toBe("shop");
  });

  it("refuses to draw more nodes than the limit", () => {
    const view = computeView(graph, { namespaces: [], hiddenLayers: [] }, 5);

    expect(view.kind).toBe("too-large");
    expect(computeView(graph, { namespaces: ["other"], hiddenLayers: ["policy", "identity", "egress", "node"] }, 5).kind).toBe("ready");
    expect(applyFilter(graph, { namespaces: [], hiddenLayers: [] })).toBe(graph);
  });
});

describe("topology layout", () => {
  it("is deterministic, compacts empty columns and orders to reduce crossings", () => {
    const nodes = [
      { id: "a", column: 0, sortKey: "a" },
      { id: "b", column: 0, sortKey: "b" },
      { id: "x", column: 5, sortKey: "a" },
      { id: "y", column: 5, sortKey: "b" },
    ];
    const edges = [
      { from: "a", to: "y" },
      { from: "b", to: "x" },
    ];
    const first = layoutGraph(nodes, edges);
    const second = layoutGraph([...nodes].reverse(), [...edges].reverse());

    expect([...first.positions.entries()].sort()).toEqual([...second.positions.entries()].sort());
    expect(first.positions.get("x")!.x).toBe(first.options.nodeWidth + first.options.columnGap);
    // a sits above b, so y (a's neighbour) moves above x: no crossing.
    expect(first.positions.get("y")!.y).toBeLessThan(first.positions.get("x")!.y);
  });

  it("centres shorter columns and gives no node the same place", () => {
    const layout = layoutGraph([{ id: "a", column: 0, sortKey: "a" }, { id: "b", column: 1, sortKey: "b" }, { id: "c", column: 1, sortKey: "c" }, { id: "d", column: 1, sortKey: "d" }], []);
    const places = new Set([...layout.positions.values()].map((position) => `${position.x},${position.y}`));

    expect(places.size).toBe(4);
    expect(layout.positions.get("a")!.y).toBe(layout.positions.get("c")!.y);
    expect(layoutGraph([], []).width).toBe(0);
  });
});

const flow = (from: [string, string] | string, to: [string, string] | string, verdict: Flow["verdict"], extra: Partial<Flow> = {}): Flow => {
  const endpoint = (value: [string, string] | string) =>
    typeof value === "string" ? { labels: [`reserved:${value}`], ip: "1.2.3.4" } : { namespace: value[0], podName: value[1], labels: [] };

  return { time: "2026-01-01T00:00:00Z", verdict, source: endpoint(from), destination: { ...endpoint(to), port: 80 }, protocol: "TCP", type: "L3_L4", ...extra };
};

describe("observed traffic", () => {
  const graph = buildGraph({ items: fixture() });

  it("overlays counts between shown pods, with verdicts and policies, skipping replies", () => {
    const traffic = observedTraffic(
      [
        flow(["shop", "web-1"], ["other", "db-1"], "FORWARDED", { allowedBy: ["CiliumNetworkPolicy shop/allow-web"] }),
        flow(["shop", "web-1"], ["other", "db-1"], "DROPPED", { dropReason: "POLICY_DENIED", deniedBy: ["NetworkPolicy other/deny-all"] }),
        flow(["other", "db-1"], ["shop", "web-1"], "FORWARDED", { isReply: true }),
        flow("world", ["shop", "web-1"], "FORWARDED"),
        flow("host", ["shop", "web-1"], "FORWARDED"),
        flow(["gone", "pod"], ["shop", "web-1"], "FORWARDED"),
      ],
      graph.nodes,
    );
    const edge = traffic.edges.find((candidate) => candidate.from === nodeId.pod("shop", "web-1"))!;

    expect(edge).toMatchObject({ to: nodeId.pod("other", "db-1"), forwarded: 1, dropped: 1, dropReasons: ["POLICY_DENIED"], allowedBy: ["CiliumNetworkPolicy shop/allow-web"], deniedBy: ["NetworkPolicy other/deny-all"] });
    expect(verdictOf(edge)).toBe("mixed");
    expect(traffic.edges.some((candidate) => candidate.from === nodeId.internet)).toBe(true);
    expect(traffic.peers.map((peer) => peer.id)).toEqual(["observed:host"]);
    expect(traffic.hiddenFlows).toBe(1);
    expect(traffic.flowCount).toBe(5);
  });

  it("draws nothing without flows", () => {
    expect(observedTraffic([], graph.nodes)).toEqual({ edges: [], peers: [], flowCount: 0, hiddenFlows: 0 });
  });
});

describe("SVG export", () => {
  it("draws every positioned node and edge from the layout, escaping text", () => {
    const graph = buildGraph({ items: { services: [{ ...meta("a<b>&", "ns"), spec: { type: "ClusterIP" } }], pods: [readyPod("p", "ns", {})], nodes: [{ ...meta("node-a"), status: {} }] } });
    const view = computeView(graph, { namespaces: [], hiddenLayers: [] }, 100, [flow(["ns", "p"], ["ns", "p"], "FORWARDED"), flow("world", ["ns", "p"], "DROPPED")]);

    if (view.kind !== "ready") throw new Error("expected a view");

    const svg = graphToSvg({ nodes: view.nodes, edges: view.graph.edges, observed: view.traffic?.edges, layout: view.layout, title: "Topology & more" });

    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("a&lt;b&gt;&amp;");
    expect(svg).toContain("Topology &amp; more");
    expect(svg).not.toContain("a<b>");
    expect((svg.match(/<rect width="232"/g) ?? []).length).toBe(view.nodes.length);
    expect((svg.match(/marker-end/g) ?? []).length).toBe(view.graph.edges.length + (view.traffic?.edges.length ?? 0));
    expect(svg).toContain('stroke-dasharray="6 4"');
  });
});
