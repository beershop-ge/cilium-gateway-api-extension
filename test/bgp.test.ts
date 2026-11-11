import { describe, expect, it } from "vitest";
import {
  advertisementsOfFamily,
  asnError,
  bgpAdvertisedServices,
  bgpSecretsNamespace,
  enabledFamilies,
  formatDuration,
  legacyAdvertisesService,
  newPeerErrors,
  parseAdvertisement,
  parseAgentPeers,
  parseAgentRoutes,
  parseClusterConfig,
  parseLegacyPolicy,
  parsePeerConfig,
  resolveAdvertisements,
  sessionsFromNodeConfig,
  sumRoutes,
  validateBgp,
  withAddedPeer,
} from "../src/bgp/bgp-model";

const clusterConfig = (peers: unknown[], { localASN = 65001, nodeSelector }: { localASN?: unknown; nodeSelector?: unknown } = {}) => ({
  apiVersion: "cilium.io/v2",
  kind: "CiliumBGPClusterConfig",
  metadata: { name: "cilium-bgp", resourceVersion: "42", managedFields: [{ manager: "kubectl" }] },
  spec: { nodeSelector, bgpInstances: [{ name: "instance-65001", localASN, peers }] },
  status: { conditions: [{ type: "cilium.io/MissingPeerConfigs", status: "False" }] },
});

const peerConfig = (name: string, spec: Record<string, unknown> = {}) => ({ apiVersion: "cilium.io/v2", kind: "CiliumBGPPeerConfig", metadata: { name }, spec });

const advertisement = (name: string, labels: Record<string, string>, advertisements: unknown[]) => ({
  apiVersion: "cilium.io/v2",
  kind: "CiliumBGPAdvertisement",
  metadata: { name, labels },
  spec: { advertisements },
});

const families = [{ afi: "ipv4", safi: "unicast", advertisements: { matchLabels: { advertise: "bgp" } } }];

describe("ASN validation", () => {
  it("accepts 1..2^32-1 and rejects the rest", () => {
    expect(asnError(65001)).toBeUndefined();
    expect(asnError(4294967295)).toBeUndefined();
    expect(asnError(0)).toMatch(/outside/);
    expect(asnError(0, { allowZero: true })).toBeUndefined();
    expect(asnError(4294967296)).toMatch(/outside/);
    expect(asnError(1.5)).toMatch(/whole number/);
    expect(asnError(undefined)).toBe("not set");
  });
});

describe("parsing configuration", () => {
  it("reads instances, peers and references of a cluster config", () => {
    const parsed = parseClusterConfig(clusterConfig([{ name: "tor", peerAddress: "10.0.0.1", peerASN: 65000, peerConfigRef: { name: "tor-config" } }], { nodeSelector: { matchLabels: { bgp: "on" } } }));

    expect(parsed.nodeSelector).toEqual({ matchLabels: { bgp: "on" } });
    expect(parsed.instances[0]).toMatchObject({ name: "instance-65001", localASN: 65001, peers: [{ name: "tor", peerAddress: "10.0.0.1", peerASN: 65000, peerConfigRef: "tor-config" }] });
    expect(parsed.conditions[0].type).toBe("cilium.io/MissingPeerConfigs");
  });

  it("reads timers, auth, multihop and graceful restart of a peer config, and defaults families", () => {
    const parsed = parsePeerConfig(
      peerConfig("tor-config", {
        timers: { holdTimeSeconds: 9, keepAliveTimeSeconds: 3, connectRetryTimeSeconds: 12 },
        authSecretRef: "bgp-auth",
        ebgpMultihop: 4,
        gracefulRestart: { enabled: true, restartTimeSeconds: 15 },
        transport: { peerPort: 1790 },
      }),
    );

    expect(parsed).toMatchObject({ holdTimeSeconds: 9, keepAliveTimeSeconds: 3, connectRetryTimeSeconds: 12, authSecretRef: "bgp-auth", ebgpMultihop: 4, gracefulRestart: { enabled: true, restartTimeSeconds: 15 }, peerPort: 1790 });
    expect(parsed.familiesDefaulted).toBe(true);
    expect(parsed.families.map((family) => family.afi)).toEqual(["ipv4", "ipv6"]);
  });

  it("matches advertisements to families by label, and selects nothing without a selector", () => {
    const ads = [parseAdvertisement(advertisement("pods", { advertise: "bgp" }, [])), parseAdvertisement(advertisement("other", { advertise: "no" }, []))];

    expect(advertisementsOfFamily({ afi: "ipv4", safi: "unicast", advertisements: { matchLabels: { advertise: "bgp" } } }, ads).map((ad) => ad.name)).toEqual(["pods"]);
    expect(advertisementsOfFamily({ afi: "ipv4", safi: "unicast" }, ads)).toEqual([]);
  });

  it("reads legacy peering policies", () => {
    const parsed = parseLegacyPolicy({
      metadata: { name: "legacy" },
      spec: { virtualRouters: [{ localASN: 64512, exportPodCIDR: true, serviceSelector: { matchLabels: { a: "b" } }, neighbors: [{ peerAddress: "172.0.0.1/32", peerASN: 64513, families: [{ afi: "ipv4", safi: "unicast" }] }] }] },
    });

    expect(parsed.virtualRouters[0]).toMatchObject({ localASN: 64512, exportPodCIDR: true, serviceAdvertisements: ["LoadBalancerIP"], neighbors: [{ peerAddress: "172.0.0.1/32", peerASN: 64513, families: ["ipv4/unicast"] }] });
  });
});

describe("validateBgp", () => {
  const base = {
    peerConfigs: [parsePeerConfig(peerConfig("tor-config", { families }))],
    advertisements: [parseAdvertisement(advertisement("pods", { advertise: "bgp" }, [{ advertisementType: "PodCIDR" }]))],
    secrets: [],
    secretsNamespace: "kube-system",
  };

  it("is clean for a consistent configuration", () => {
    const issues = validateBgp({ ...base, clusterConfigs: [parseClusterConfig(clusterConfig([{ name: "tor", peerAddress: "10.0.0.1", peerASN: 65000, peerConfigRef: { name: "tor-config" } }]))] });

    expect(issues.filter((issue) => issue.severity !== "info")).toEqual([]);
  });

  it("reports a peerConfigRef to a missing peer config", () => {
    const issues = validateBgp({ ...base, clusterConfigs: [parseClusterConfig(clusterConfig([{ name: "tor", peerAddress: "10.0.0.1", peerASN: 65000, peerConfigRef: { name: "missing" } }]))] });

    expect(issues).toContainEqual(expect.objectContaining({ severity: "error", message: expect.stringContaining('"missing" names a CiliumBGPPeerConfig that does not exist') }));
  });

  it("reports families that select no advertisement and peer configs without families", () => {
    const issues = validateBgp({
      ...base,
      clusterConfigs: [],
      peerConfigs: [parsePeerConfig(peerConfig("a", { families: [{ afi: "ipv6", safi: "unicast", advertisements: { matchLabels: { advertise: "nothing" } } }] })), parsePeerConfig(peerConfig("b"))],
    });

    expect(issues).toContainEqual(expect.objectContaining({ name: "a", severity: "warning", message: expect.stringContaining("ipv6/unicast selects no CiliumBGPAdvertisement") }));
    expect(issues).toContainEqual(expect.objectContaining({ name: "b", severity: "warning", message: expect.stringContaining("No families") }));
  });

  it("checks the auth secret by name in the BGP secrets namespace, never by value", () => {
    const peerConfigs = [parsePeerConfig(peerConfig("tor-config", { families, authSecretRef: "bgp-auth" }))];
    const missing = validateBgp({ ...base, peerConfigs, clusterConfigs: [], secrets: [{ name: "bgp-auth", namespace: "default", keys: ["password"] }] });
    const noKey = validateBgp({ ...base, peerConfigs, clusterConfigs: [], secrets: [{ name: "bgp-auth", namespace: "kube-system", keys: ["pw"] }] });
    const ok = validateBgp({ ...base, peerConfigs, clusterConfigs: [], secrets: [{ name: "bgp-auth", namespace: "kube-system", keys: ["password"] }] });
    const unreadable = validateBgp({ ...base, peerConfigs, clusterConfigs: [], secrets: undefined });

    expect(missing).toContainEqual(expect.objectContaining({ severity: "error", message: expect.stringContaining('"bgp-auth" does not exist in namespace kube-system') }));
    expect(noKey).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringContaining('no "password" key') }));
    expect(ok.filter((issue) => issue.message.includes("bgp-auth"))).toEqual([]);
    expect(unreadable).toContainEqual(expect.objectContaining({ severity: "info", message: expect.stringContaining("could not be checked") }));
  });

  it("reports ASNs out of range, invalid addresses and duplicate peers", () => {
    const issues = validateBgp({
      ...base,
      clusterConfigs: [
        parseClusterConfig(
          clusterConfig(
            [
              { name: "a", peerAddress: "10.0.0.1", peerASN: 4294967296, peerConfigRef: { name: "tor-config" } },
              { name: "a", peerAddress: "10.0.0.01x", peerASN: 65000 },
              { name: "c", peerAddress: "fd00::1", peerASN: 65000 },
              { name: "d", peerAddress: "fd00:0::1", peerASN: 65000 },
            ],
            { localASN: 0 },
          ),
        ),
      ],
    });
    const messages = issues.filter((issue) => issue.severity === "error").map((issue) => issue.message);

    expect(messages).toContainEqual(expect.stringContaining("local ASN 0 is outside"));
    expect(messages).toContainEqual(expect.stringContaining("peer ASN 4294967296 is outside"));
    expect(messages).toContainEqual(expect.stringContaining('"10.0.0.01x" is not a valid IP address'));
    expect(messages).toContainEqual(expect.stringContaining('peer name "a" is used 2 times'));
    expect(messages).toContainEqual(expect.stringContaining("peer address fd00::1 is configured 2 times"));
  });

  it("validates legacy policies and warns when both control planes are configured", () => {
    const issues = validateBgp({
      ...base,
      clusterConfigs: [parseClusterConfig(clusterConfig([]))],
      legacyPolicies: [
        parseLegacyPolicy({
          metadata: { name: "legacy" },
          spec: { virtualRouters: [{ localASN: 64512, neighbors: [{ peerAddress: "10.1.1.1/32", peerASN: 0 }, { peerAddress: "10.1.1.1/32", peerASN: 65000, authSecretRef: "gone" }] }] },
        }),
      ],
    });

    expect(issues).toContainEqual(expect.objectContaining({ kind: "CiliumBGPPeeringPolicy", message: expect.stringContaining("peer ASN 0 is outside") }));
    expect(issues).toContainEqual(expect.objectContaining({ kind: "CiliumBGPPeeringPolicy", message: expect.stringContaining("configured 2 times") }));
    expect(issues).toContainEqual(expect.objectContaining({ kind: "CiliumBGPPeeringPolicy", message: expect.stringContaining('"gone" does not exist') }));
    expect(issues).toContainEqual(expect.objectContaining({ message: expect.stringContaining("Both legacy") }));
  });

  it("sorts errors first", () => {
    const issues = validateBgp({ ...base, peerConfigs: [parsePeerConfig(peerConfig("x"))], clusterConfigs: [parseClusterConfig(clusterConfig([{ name: "p", peerAddress: "bad" }]))] });

    expect(issues[0].severity).toBe("error");
  });

  it("reads the secrets namespace from cilium-config", () => {
    expect(bgpSecretsNamespace(undefined)).toBe("kube-system");
    expect(bgpSecretsNamespace({ "bgp-secrets-namespace": "cilium-bgp" })).toBe("cilium-bgp");
  });
});

describe("adding a peer", () => {
  const config = clusterConfig([{ name: "tor", peerAddress: "10.0.0.1", peerASN: 65000 }]);

  it("validates the new peer against the instance", () => {
    const parsed = parseClusterConfig(config);

    expect(newPeerErrors(parsed, { instance: "instance-65001", name: "tor", peerAddress: "10.0.0.1" })).toMatchObject({ name: expect.any(String), peerAddress: expect.any(String) });
    expect(newPeerErrors(parsed, { instance: "nope", name: "x", peerAddress: "10.0.0.9/32" })).toMatchObject({ instance: expect.any(String), peerAddress: expect.any(String) });
    expect(newPeerErrors(parsed, { instance: "instance-65001", name: "tor2", peerAddress: "10.0.0.2", peerASN: 65002 })).toEqual({});
  });

  it("appends the peer and keeps everything else, including the resourceVersion", () => {
    const next = withAddedPeer(config, { instance: "instance-65001", name: "tor2", peerAddress: "10.0.0.2", peerASN: 65002, peerConfigRef: "tor-config" });

    expect(next.spec.bgpInstances[0].peers).toEqual([
      { name: "tor", peerAddress: "10.0.0.1", peerASN: 65000 },
      { name: "tor2", peerAddress: "10.0.0.2", peerASN: 65002, peerConfigRef: { name: "tor-config" } },
    ]);
    expect(next.metadata.resourceVersion).toBe("42");
    expect(next.metadata.managedFields).toBeUndefined();
    expect(next.status).toBeUndefined();
    expect(config.spec.bgpInstances[0].peers).toHaveLength(1);
  });
});

describe("session status", () => {
  it("parses CiliumBGPNodeConfig status", () => {
    const now = Date.parse("2026-01-01T01:00:00Z");
    const sessions = sessionsFromNodeConfig(
      {
        metadata: { name: "node-1" },
        status: {
          bgpInstances: [
            {
              name: "instance-65001",
              localASN: 65001,
              peers: [
                {
                  name: "tor",
                  peerAddress: "10.0.0.1",
                  peerASN: 65000,
                  peeringState: "established",
                  establishedTime: "2026-01-01T00:00:00Z",
                  timers: { appliedHoldTimeSeconds: 90, appliedKeepaliveSeconds: 30 },
                  routeCount: [{ afi: "ipv4", safi: "unicast", advertised: 3, received: 1 }, { afi: "ipv6", safi: "unicast", advertised: 2, received: 0 }],
                },
                { name: "tor2", peerAddress: "10.0.0.2", peerASN: 65000, peeringState: "active" },
              ],
            },
          ],
        },
      },
      now,
    );

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ node: "node-1", instance: "instance-65001", localASN: 65001, peerAddress: "10.0.0.1", established: true, uptimeSeconds: 3600, holdTimeSeconds: 90, keepAliveSeconds: 30, source: "node-config-status" });
    expect(sumRoutes(sessions[0].routes, "advertised")).toBe(5);
    expect(sumRoutes(sessions[0].routes, "received")).toBe(1);
    expect(sessions[1]).toMatchObject({ established: false, state: "active", uptimeSeconds: undefined });
    expect(sumRoutes(sessions[1].routes, "advertised")).toBeUndefined();
  });

  it("returns nothing for a node config without status", () => {
    expect(sessionsFromNodeConfig({ metadata: { name: "n" }, spec: {} })).toEqual([]);
  });

  it("parses cilium-dbg bgp peers JSON", () => {
    const sessions = parseAgentPeers(
      [
        {
          "applied-hold-time-seconds": 90,
          "applied-keep-alive-time-seconds": 30,
          "configured-hold-time-seconds": 90,
          "connect-retry-time-seconds": 120,
          families: [{ afi: "ipv4", safi: "unicast", accepted: 1, advertised: 2, received: 1 }],
          "local-asn": 65001,
          "peer-address": "10.0.0.1",
          "peer-asn": 65000,
          "peer-port": 179,
          "session-state": "established",
          "uptime-nanoseconds": 125_000_000_000,
        },
        { "local-asn": 65001, "peer-address": "10.0.0.2", "peer-asn": 65000, "session-state": "connect", "uptime-nanoseconds": 0 },
      ],
      "node-1",
    );

    expect(sessions[0]).toMatchObject({ node: "node-1", established: true, uptimeSeconds: 125, holdTimeSeconds: 90, keepAliveSeconds: 30, connectRetrySeconds: 120, peerPort: 179, source: "agent" });
    expect(sessions[0].routes[0]).toEqual({ afi: "ipv4", safi: "unicast", advertised: 2, received: 1, accepted: 1 });
    expect(sessions[1]).toMatchObject({ established: false, state: "connect", uptimeSeconds: undefined });
    expect(() => parseAgentPeers({ error: "x" }, "n")).toThrow();
  });

  it("formats durations", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(3725)).toBe("1h 2m");
    expect(formatDuration(90000)).toBe("1d 1h");
  });
});

describe("routes", () => {
  it("parses cilium-dbg bgp routes advertised JSON", () => {
    const routes = parseAgentRoutes([
      { "router-asn": 65001, neighbor: "10.0.0.1", prefix: "10.244.1.0/24", paths: [{ "age-nanoseconds": 5_000_000_000, best: true, family: { afi: "ipv4", safi: "unicast" } }] },
      { "router-asn": 65001, neighbor: "10.0.0.1", prefix: "172.18.0.10/32", paths: [] },
    ]);

    expect(routes).toEqual([
      { prefix: "10.244.1.0/24", neighbor: "10.0.0.1", routerAsn: 65001, best: true, ageSeconds: 5, family: "ipv4/unicast" },
      { prefix: "172.18.0.10/32", neighbor: "10.0.0.1", routerAsn: 65001 },
    ]);
    expect(parseAgentRoutes(null)).toEqual([]);
  });

  it("resolves advertisements to the services, pod CIDRs and pool CIDRs they select", () => {
    const services = [
      { metadata: { name: "web", namespace: "prod", labels: { bgp: "yes" } }, spec: { type: "LoadBalancer", clusterIPs: ["10.96.0.10"], externalTrafficPolicy: "Local" }, status: { loadBalancer: { ingress: [{ ip: "172.18.0.10" }] } } },
      { metadata: { name: "l2", namespace: "prod", labels: { bgp: "yes" } }, spec: { type: "LoadBalancer", loadBalancerClass: "io.cilium/l2-announcer", clusterIPs: ["10.96.0.11"] }, status: { loadBalancer: { ingress: [{ ip: "172.18.0.11" }] } } },
      { metadata: { name: "other", namespace: "prod" }, spec: { type: "ClusterIP", clusterIPs: ["10.96.0.12"] } },
    ];
    const nodes = [
      { metadata: { name: "node-1", labels: { bgp: "on" } } },
      { metadata: { name: "node-2", labels: {} }, spec: { podCIDRs: ["10.244.2.0/24"] } },
    ];
    const ciliumNodes = [
      { metadata: { name: "node-1" }, spec: { ipam: { podCIDRs: ["10.244.1.0/24"], pools: { allocated: [{ pool: "blue", cidrs: ["10.10.0.0/27"] }] } } } },
      { metadata: { name: "node-2" }, spec: { ipam: {} } },
    ];
    const resolved = resolveAdvertisements({
      clusterConfigs: [parseClusterConfig(clusterConfig([{ name: "tor", peerAddress: "10.0.0.1", peerConfigRef: { name: "tor-config" } }], { nodeSelector: { matchLabels: { bgp: "on" } } }))],
      peerConfigs: [parsePeerConfig(peerConfig("tor-config", { families }))],
      advertisements: [
        parseAdvertisement(
          advertisement("all", { advertise: "bgp" }, [
            { advertisementType: "PodCIDR" },
            { advertisementType: "Service", service: { addresses: ["LoadBalancerIP", "ClusterIP"] }, selector: { matchLabels: { bgp: "yes" } } },
            { advertisementType: "CiliumPodIPPool", selector: { matchLabels: { pool: "blue" } } },
            { advertisementType: "Service", service: { addresses: ["LoadBalancerIP"] } },
          ]),
        ),
        parseAdvertisement(advertisement("unused", { advertise: "nope" }, [{ advertisementType: "PodCIDR" }])),
      ],
      services,
      nodes,
      ciliumNodes,
      podIPPools: [{ metadata: { name: "blue", labels: { pool: "blue" } }, spec: { ipv4: { cidrs: ["10.10.0.0/16"] } } }],
    });

    const [podCidr, service, pool, noSelector, unused] = resolved;

    expect(podCidr.nodes).toEqual(["node-1"]);
    expect(podCidr.usedBy).toEqual([{ peerConfig: "tor-config", family: "ipv4/unicast" }]);
    expect(podCidr.prefixes.map((prefix) => prefix.prefix)).toEqual(["10.244.1.0/24"]);
    expect(service.prefixes.map((prefix) => prefix.prefix)).toEqual(["172.18.0.10/32", "10.96.0.10/32", "10.96.0.11/32"]);
    expect(service.prefixes[0].note).toMatch(/externalTrafficPolicy Local/);
    expect(service.notes).toContainEqual(expect.stringContaining("prod/l2: loadBalancerClass io.cilium/l2-announcer"));
    expect(pool.prefixes).toEqual([expect.objectContaining({ prefix: "10.10.0.0/27", originName: "blue" })]);
    expect(noSelector.prefixes).toEqual([]);
    expect(noSelector.notes[0]).toMatch(/No selector/);
    expect(unused.usedBy).toEqual([]);
    expect(unused.notes[0]).toMatch(/No peer config family selects/);
  });

  it("knows which families the agents serve", () => {
    expect(enabledFamilies(undefined)).toEqual(["ipv4"]);
    expect(enabledFamilies({ "enable-ipv4": "true", "enable-ipv6": "true" })).toEqual(["ipv4", "ipv6"]);
    expect(enabledFamilies({ "enable-ipv4": "false", "enable-ipv6": "true" })).toEqual(["ipv6"]);
  });
});

describe("which services BGP advertises", () => {
  it("collects LoadBalancer services of used advertisements, and matches legacy policies", () => {
    const lb = { metadata: { name: "web", namespace: "prod", labels: { bgp: "yes" } }, spec: { type: "LoadBalancer" }, status: { loadBalancer: { ingress: [{ ip: "172.18.0.10" }] } } };
    const resolved = resolveAdvertisements({
      clusterConfigs: [parseClusterConfig(clusterConfig([{ name: "tor", peerAddress: "10.0.0.1", peerConfigRef: { name: "tor-config" } }]))],
      peerConfigs: [parsePeerConfig(peerConfig("tor-config", { families }))],
      advertisements: [parseAdvertisement(advertisement("svc", { advertise: "bgp" }, [{ advertisementType: "Service", service: { addresses: ["LoadBalancerIP"] }, selector: { matchLabels: { bgp: "yes" } } }]))],
      services: [lb],
      nodes: [{ metadata: { name: "n1", labels: {} } }],
      ciliumNodes: [],
      podIPPools: [],
    });

    expect([...bgpAdvertisedServices(resolved)]).toEqual(["prod/web"]);

    const legacy = parseLegacyPolicy({ metadata: { name: "l" }, spec: { virtualRouters: [{ localASN: 1, serviceSelector: { matchLabels: { bgp: "yes" } }, neighbors: [{ peerAddress: "10.0.0.1/32", peerASN: 2 }] }] } });

    expect(legacyAdvertisesService(legacy, lb)).toBe(true);
    expect(legacyAdvertisesService(legacy, { ...lb, spec: { type: "LoadBalancer", loadBalancerClass: "io.cilium/l2-announcer" } })).toBe(false);
  });
});
