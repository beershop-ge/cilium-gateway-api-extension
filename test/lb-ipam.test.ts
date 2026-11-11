import { describe, expect, it } from "vitest";
import { ipamMode, ipamTotals, nodeIpam, podIpPoolUsage } from "../src/lb-ipam/ipam-model";
import {
  assignIpsToPools,
  buildServiceEdit,
  eligiblePools,
  findPoolOverlaps,
  l2LeaseName,
  lbIpamHandlesClass,
  leaseHolders,
  nodesOfL2Policy,
  parseL2Policy,
  parseLbService,
  parsePool,
  pendingReason,
  poolUsage,
  serviceEditErrors,
  servicesOfL2Policy,
} from "../src/lb-ipam/lb-model";

const pool = (name: string, spec: Record<string, unknown>, conditions: unknown[] = []) => ({ apiVersion: "cilium.io/v2alpha1", kind: "CiliumLoadBalancerIPPool", metadata: { name }, spec, status: { conditions } });

const service = (namespace: string, name: string, { ips = [] as string[], labels = {} as Record<string, string>, annotations = {} as Record<string, string>, loadBalancerClass, loadBalancerIP, conditions, externalIPs }: Record<string, any> = {}) => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { namespace, name, labels, annotations, resourceVersion: "7", managedFields: [{}] },
  spec: { type: "LoadBalancer", loadBalancerClass, loadBalancerIP, externalIPs },
  status: { loadBalancer: { ingress: ips.map((ip: string) => ({ ip })) }, conditions },
});

describe("pools", () => {
  it("sizes CIDR and range blocks, skipping first and last of CIDRs unless allowed", () => {
    const parsed = parsePool(pool("a", { blocks: [{ cidr: "10.0.0.0/24" }, { start: "10.0.1.10", stop: "10.0.1.19" }, { cidr: "10.0.2.5/32" }, { cidr: "nope" }] }));

    expect(parsed.blocks.map((block) => [block.size, block.usable])).toEqual([
      [256n, 254n],
      [10n, 10n],
      [1n, 1n],
      [0n, 0n],
    ]);
    expect(parsed.blocks[3].error).toBeDefined();
    expect(parsed.usable).toBe(265n);
    expect(parsePool(pool("b", { allowFirstLastIPs: "Yes", blocks: [{ cidr: "10.0.0.0/24" }] })).usable).toBe(256n);
  });

  it("reads the older spec.cidrs, the disabled flag and operator conditions", () => {
    const parsed = parsePool(
      pool("old", { cidrs: [{ cidr: "fd00::/120" }], disabled: true }, [
        { type: "cilium.io/IPsTotal", status: "Unknown", message: "256" },
        { type: "cilium.io/IPsAvailable", status: "Unknown", message: "250" },
        { type: "cilium.io/IPsUsed", status: "Unknown", message: "6" },
        { type: "cilium.io/PoolConflict", status: "True", reason: "cidr_overlap", message: "Pool overlaps with new-pool" },
      ]),
    );

    expect(parsed.disabled).toBe(true);
    expect(parsed.usable).toBe(254n);
    expect(parsed.reported).toEqual({ total: 256, available: 250, used: 6 });
    expect(parsed.conflict).toBe("Pool overlaps with new-pool");
  });

  it("finds overlapping blocks across and within pools, per family", () => {
    const overlaps = findPoolOverlaps([
      parsePool(pool("a", { blocks: [{ cidr: "10.0.0.0/24" }, { cidr: "fd00::/64" }] })),
      parsePool(pool("b", { blocks: [{ start: "10.0.0.250", stop: "10.0.1.5" }, { cidr: "10.0.2.0/24" }] })),
      parsePool(pool("c", { blocks: [{ cidr: "10.0.2.128/25" }, { cidr: "10.0.2.130/32" }, { cidr: "fd01::/64" }] })),
    ]);

    expect(overlaps).toEqual([
      { poolA: "a", blockA: "10.0.0.0/24", poolB: "b", blockB: "10.0.0.250–10.0.1.5" },
      { poolA: "b", blockA: "10.0.2.0/24", poolB: "c", blockB: "10.0.2.128/25" },
      { poolA: "b", blockA: "10.0.2.0/24", poolB: "c", blockB: "10.0.2.130/32" },
      { poolA: "c", blockA: "10.0.2.128/25", poolB: "c", blockB: "10.0.2.130/32" },
    ]);
  });
});

describe("assigning IPs to pools", () => {
  const pools = [parsePool(pool("a", { blocks: [{ cidr: "10.0.0.0/24" }] })), parsePool(pool("b", { blocks: [{ cidr: "10.0.0.128/25" }, { cidr: "fd00::/120" }] }))];
  const services = [
    parseLbService(service("prod", "web", { ips: ["10.0.0.5"] })),
    parseLbService(service("prod", "api", { ips: ["10.0.0.200", "fd00::5"] })),
    parseLbService(service("dev", "api", { ips: ["10.0.0.200"], annotations: { "lbipam.cilium.io/sharing-key": "k" } })),
    parseLbService(service("ext", "lb", { ips: ["192.168.1.1"] })),
  ];
  const assignments = assignIpsToPools(pools, services);

  it("places each IP in every pool containing it, counting a shared IP once", () => {
    expect(assignments.byPool.get("a")!.map((entry) => entry.ip)).toEqual(["10.0.0.5", "10.0.0.200"]);
    expect(assignments.byPool.get("b")!.map((entry) => entry.ip)).toEqual(["10.0.0.200", "fd00::5"]);
    expect(assignments.byPool.get("a")![1].services).toEqual([
      { namespace: "prod", name: "api" },
      { namespace: "dev", name: "api" },
    ]);
    expect(assignments.outsidePools).toEqual([{ ip: "192.168.1.1", services: [{ namespace: "ext", name: "lb" }] }]);
    expect(assignments.poolsOfService.get("prod/api")).toEqual(["a", "b"]);
    expect(assignments.poolsOfService.get("ext/lb")).toEqual([]);
  });

  it("computes usage against usable addresses", () => {
    const usage = poolUsage(pools[0], assignments.byPool.get("a")!);

    expect(usage.used).toBe(2);
    expect(usage.usable).toBe(254n);
    expect(usage.percent).toBeCloseTo((2 / 254) * 100);
  });
});

describe("services", () => {
  it("collects requested IPs from annotations and spec, and Cilium annotations", () => {
    const parsed = parseLbService(
      service("prod", "web", { loadBalancerIP: "10.0.0.9", annotations: { "lbipam.cilium.io/ips": "10.0.0.7, 10.0.0.8", "io.cilium/lb-ipam-ips": "10.0.0.7", "lbipam.cilium.io/sharing-key": "shared", other: "x" } }),
    );

    expect(parsed.requestedIPs).toEqual(["10.0.0.7", "10.0.0.8", "10.0.0.9"]);
    expect(parsed.requestSources).toEqual(["lbipam.cilium.io/ips", "io.cilium/lb-ipam-ips", "spec.loadBalancerIP"]);
    expect(parsed.sharingKey).toBe("shared");
    expect(Object.keys(parsed.ciliumAnnotations).sort()).toEqual(["io.cilium/lb-ipam-ips", "lbipam.cilium.io/ips", "lbipam.cilium.io/sharing-key"]);
    expect(parsed.selectorLabels["io.kubernetes.service.namespace"]).toBe("prod");
  });

  it("matches pools by service selector, including the namespace pseudo-label", () => {
    const pools = [parsePool(pool("prod-only", { serviceSelector: { matchLabels: { "io.kubernetes.service.namespace": "prod" } }, blocks: [] })), parsePool(pool("all", { blocks: [] }))];

    expect(eligiblePools(pools, parseLbService(service("prod", "web"))).map((p) => p.name)).toEqual(["prod-only", "all"]);
    expect(eligiblePools(pools, parseLbService(service("dev", "web"))).map((p) => p.name)).toEqual(["all"]);
  });

  it("explains why a service has no address", () => {
    const pools = [parsePool(pool("prod", { serviceSelector: { matchLabels: { tier: "prod" } }, blocks: [{ cidr: "10.0.0.0/24" }] }))];
    const disabled = [parsePool(pool("off", { disabled: true, blocks: [{ cidr: "10.0.0.0/24" }] }))];
    const full = [parsePool(pool("full", { blocks: [{ cidr: "10.0.0.0/30" }] }, [{ type: "cilium.io/IPsAvailable", status: "Unknown", message: "0" }]))];

    expect(pendingReason(parseLbService(service("a", "b", { ips: ["10.0.0.1"] })), pools)).toBeUndefined();
    expect(pendingReason(parseLbService(service("a", "b", { conditions: [{ type: "cilium.io/IPAMRequestSatisfied", status: "False", reason: "no_pool", message: "There are no enabled pools" }] })), pools)).toBe(
      "LB IPAM: no_pool — There are no enabled pools",
    );
    expect(pendingReason(parseLbService(service("a", "b", { loadBalancerClass: "service.k8s.aws/nlb" })), pools)).toMatch(/another controller/);
    expect(pendingReason(parseLbService(service("a", "b")), [], { lbIpamEnabled: false })).toMatch(/not available/);
    expect(pendingReason(parseLbService(service("a", "b")), [])).toMatch(/no CiliumLoadBalancerIPPool/);
    expect(pendingReason(parseLbService(service("a", "b")), pools)).toMatch(/No pool's serviceSelector/);
    expect(pendingReason(parseLbService(service("a", "b")), disabled)).toMatch(/disabled or in conflict/);
    expect(pendingReason(parseLbService(service("a", "b", { labels: { tier: "prod" }, annotations: { "lbipam.cilium.io/ips": "192.168.0.1" } })), pools)).toMatch(/192.168.0.1 is in no enabled pool/);
    expect(pendingReason(parseLbService(service("a", "b")), full)).toMatch(/no available addresses/);
    expect(pendingReason(parseLbService(service("a", "b", { labels: { tier: "prod" } })), pools)).toBeUndefined();
  });

  it("knows which classes LB IPAM serves", () => {
    expect(lbIpamHandlesClass(undefined)).toBe(true);
    expect(lbIpamHandlesClass("io.cilium/l2-announcer")).toBe(true);
    expect(lbIpamHandlesClass("metallb.io/metallb")).toBe(false);
  });
});

describe("L2 announcements", () => {
  const policy = parseL2Policy({
    metadata: { name: "l2" },
    spec: { serviceSelector: { matchLabels: { l2: "yes" } }, nodeSelector: { matchExpressions: [{ key: "node-role.kubernetes.io/control-plane", operator: "DoesNotExist" }] }, interfaces: ["^eth[0-9]+"], loadBalancerIPs: true },
  });

  it("selects services with a matching label, an L2-compatible class and a LoadBalancer IP", () => {
    const services = [
      parseLbService(service("prod", "a", { ips: ["10.0.0.1"], labels: { l2: "yes" } })),
      parseLbService(service("prod", "b", { ips: ["10.0.0.2"], labels: { l2: "yes" }, loadBalancerClass: "io.cilium/bgp-control-plane" })),
      parseLbService(service("prod", "c", { labels: { l2: "yes" } })),
      parseLbService(service("prod", "d", { ips: ["10.0.0.4"] })),
      parseLbService(service("prod", "e", { ips: ["10.0.0.5"], labels: { l2: "yes" }, loadBalancerClass: "io.cilium/l2-announcer" })),
    ];

    expect(servicesOfL2Policy(policy, services).map((s) => s.name)).toEqual(["a", "e"]);
    expect(policy).toMatchObject({ interfaces: ["^eth[0-9]+"], loadBalancerIPs: true, externalIPs: false });
  });

  it("selects nodes by node selector", () => {
    expect(nodesOfL2Policy(policy, [{ metadata: { name: "cp", labels: { "node-role.kubernetes.io/control-plane": "" } } }, { metadata: { name: "w1", labels: {} } }])).toEqual(["w1"]);
  });

  it("finds the announcing node from the lease", () => {
    const holders = leaseHolders([
      { metadata: { name: "cilium-l2announce-prod-a" }, spec: { holderIdentity: "w1", leaseDurationSeconds: 15 } },
      { metadata: { name: "cilium-operator-resource-lock" }, spec: { holderIdentity: "op" } },
    ]);

    expect(holders.get(l2LeaseName({ namespace: "prod", name: "a" }))).toMatchObject({ holder: "w1", leaseDurationSeconds: 15 });
    expect(holders.size).toBe(1);
  });
});

describe("editing a service", () => {
  const live = service("prod", "web", { ips: ["10.0.0.1"], annotations: { "lbipam.cilium.io/ips": "10.0.0.1", "lbipam.cilium.io/sharing-key": "old", "team": "a" } });

  it("replaces Cilium annotations, keeps the rest and the resourceVersion, and drops status", () => {
    const next = buildServiceEdit(live, { annotations: { "lbipam.cilium.io/ips": "10.0.0.2", "lbipam.cilium.io/sharing-key": "  " }, loadBalancerClass: "io.cilium/l2-announcer" });

    expect(next.metadata.annotations).toEqual({ team: "a", "lbipam.cilium.io/ips": "10.0.0.2" });
    expect(next.metadata.resourceVersion).toBe("7");
    expect(next.metadata.managedFields).toBeUndefined();
    expect(next.status).toBeUndefined();
    expect(next.spec.loadBalancerClass).toBe("io.cilium/l2-announcer");
    expect(live.metadata.annotations["lbipam.cilium.io/sharing-key"]).toBe("old");
  });

  it("refuses to change a class that is already set", () => {
    const withClass = service("prod", "web", { loadBalancerClass: "io.cilium/bgp-control-plane" });

    expect(() => buildServiceEdit(withClass, { annotations: {}, loadBalancerClass: "io.cilium/l2-announcer" })).toThrow(/immutable/);
    expect(buildServiceEdit(withClass, { annotations: {}, loadBalancerClass: "io.cilium/bgp-control-plane" }).spec.loadBalancerClass).toBe("io.cilium/bgp-control-plane");
  });

  it("validates requested IPs and the class name", () => {
    expect(serviceEditErrors({ annotations: { "lbipam.cilium.io/ips": "10.0.0.1, nope" } })).toEqual(["lbipam.cilium.io/ips: nope is not an IP address"]);
    expect(serviceEditErrors({ annotations: {}, loadBalancerClass: "Bad Class" })).toHaveLength(1);
    expect(serviceEditErrors({ annotations: {}, loadBalancerClass: "io.cilium/bgp-control-plane" })).toEqual([]);
  });
});

describe("pod IPAM", () => {
  const nodes = [
    nodeIpam({
      metadata: { name: "n1" },
      spec: { ipam: { podCIDRs: ["10.244.1.0/24"] } },
      status: { ipam: { used: { "10.244.1.5": { owner: "a" }, "10.244.1.6": { owner: "b" } }, "operator-status": {} } },
    }),
    nodeIpam({
      metadata: { name: "n2" },
      spec: { ipam: { pools: { requested: [{ pool: "blue", needed: { "ipv4-addrs": 16 } }], allocated: [{ pool: "blue", cidrs: ["10.10.0.0/28"] }, { pool: "red", cidrs: ["10.20.0.0/28"] }] } } },
      status: { ipam: { used: { "10.10.0.1": {}, "10.10.0.2": {}, "10.20.0.3": {} }, "operator-status": { error: "pool exhausted" } } },
    }),
    nodeIpam({ metadata: { name: "n3" }, spec: { ipam: { pool: { "10.1.0.5": { resource: "eni-1" }, "10.1.0.6": { resource: "eni-1" } } } }, status: { ipam: { used: { "10.1.0.5": {} } } } }),
  ];

  it("reads capacity and usage per node in each mode", () => {
    expect(nodes[0]).toMatchObject({ node: "n1", capacity: 256n, capacitySource: "podCIDRs", used: 2 });
    expect(nodes[1]).toMatchObject({ capacity: 32n, capacitySource: "pools", used: 3, operatorError: "pool exhausted" });
    expect(nodes[1].pools).toEqual([
      { pool: "blue", cidrs: ["10.10.0.0/28"], capacity: 16n, used: 2 },
      { pool: "red", cidrs: ["10.20.0.0/28"], capacity: 16n, used: 1 },
    ]);
    expect(nodes[2]).toMatchObject({ capacity: 2n, capacitySource: "pool", used: 1 });
  });

  it("sums CiliumPodIPPool usage over nodes", () => {
    const usage = podIpPoolUsage([{ metadata: { name: "blue" }, spec: { ipv4: { cidrs: ["10.10.0.0/16"], maskSize: 28 } } }], nodes);

    expect(usage).toEqual([{ name: "blue", cidrs: ["10.10.0.0/16"], maskSizes: { ipv4: 28, ipv6: undefined }, size: 65536n, allocatedToNodes: 16n, nodeCount: 1, used: 2 }]);
  });

  it("totals nodes and the cluster pool", () => {
    const totals = ipamTotals(nodes, { "cluster-pool-ipv4-cidr": "10.244.0.0/16", "cluster-pool-ipv4-mask-size": "24" });

    expect(totals).toMatchObject({ nodes: 3, capacity: 290n, used: 6, nodesWithErrors: 1 });
    expect(totals.clusterPool).toEqual([{ cidr: "10.244.0.0/16", size: 65536n, maskSize: 24, nodeCidrs: 256n }]);
  });

  it("names the IPAM mode, defaulting to cluster-pool", () => {
    expect(ipamMode(undefined)).toBeUndefined();
    expect(ipamMode({})!.mode).toBe("cluster-pool");
    expect(ipamMode({ ipam: "multi-pool" })!.label).toBe("Multi-pool");
  });
});
