import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowEndpoint } from "../src/observability/hubble";
import { buildManifest, changeKind, parsePolicy, PolicyParseError } from "../src/policy/manifest";
import {
  addPeerToRule,
  addRule,
  addRuleWithPeer,
  moveRule,
  newPolicyModel,
  newPort,
  newPortRule,
  newRule,
  type Peer,
  type PolicyModel,
  updateSection,
} from "../src/policy/model";
import { allowKubeDns, dnsPatternMatches, policyModelIssues, policySafetyFindings, portsAllow } from "../src/policy/safety";
import { coverageByNamespace, endpointsFrom, modelSelectsEndpoint, policyRefOf, policyStatusOf } from "../src/policy/selection";
import { applySuggestions, flowFilterFor, stableWorkloadLabels, suggestRules } from "../src/policy/suggestions";
import { summarizeModel } from "../src/policy/summary";

const cnp = {
  apiVersion: "cilium.io/v2",
  kind: "CiliumNetworkPolicy",
  metadata: { name: "web", namespace: "shop", resourceVersion: "42", uid: "u1", labels: { team: "a" }, managedFields: [{ manager: "kubectl" }] },
  spec: {
    description: "Web tier",
    endpointSelector: { matchLabels: { app: "web" }, matchExpressions: [{ key: "tier", operator: "In", values: ["front"] }] },
    enableDefaultDeny: { egress: false },
    ingress: [
      {
        fromEndpoints: [{ matchLabels: { app: "lb" } }, { matchLabels: { "k8s:io.kubernetes.pod.namespace": "monitoring" } }],
        toPorts: [{ ports: [{ port: "80", protocol: "TCP" }], rules: { http: [{ method: "GET", path: "/api/.*", headers: ["X-Env: prod"], headerMatches: [{ name: "x", value: "y" }] }] } }],
        authentication: { mode: "required" },
      },
      { fromEntities: ["cluster", "host"], icmps: [{ fields: [{ type: 8 }] }] },
    ],
    egress: [
      { toEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s:k8s-app": "kube-dns" } }], toPorts: [{ ports: [{ port: "53", protocol: "ANY" }], rules: { dns: [{ matchPattern: "*" }] } }] },
      { toFQDNs: [{ matchName: "api.example.com" }, { matchPattern: "*.example.org" }], toPorts: [{ ports: [{ port: "443" }] }] },
      { toCIDRSet: [{ cidr: "10.0.0.0/8", except: ["10.1.0.0/16"] }, { cidrGroupRef: "partners" }, { cidrGroupSelector: { matchLabels: { a: "b" } } }] },
      { toCIDR: ["192.0.2.10/32"] },
      { toServices: [{ k8sService: { serviceName: "db", namespace: "data" } }, { k8sServiceSelector: { selector: { matchLabels: { x: "y" } }, namespace: "data" } }] },
    ],
    egressDeny: [{ toEntities: ["world"], toPorts: [{ ports: [{ port: "25", endPort: 26, protocol: "TCP" }] }] }],
  },
  status: { conditions: [{ type: "Valid", status: "True", message: "Policy validation succeeded" }] },
};

const networkPolicy = {
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: { name: "db", namespace: "data" },
  spec: {
    podSelector: { matchLabels: { app: "db" } },
    policyTypes: ["Ingress", "Egress"],
    ingress: [
      {
        from: [
          { podSelector: { matchLabels: { app: "api" } } },
          { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "shop" } }, podSelector: { matchLabels: { app: "web" } } },
          { namespaceSelector: { matchLabels: { env: "prod" } } },
          { ipBlock: { cidr: "172.16.0.0/12", except: ["172.16.1.0/24"] } },
        ],
        ports: [{ protocol: "TCP", port: 5432 }, { protocol: "TCP", port: 6000, endPort: 6010 }, { port: "metrics" }],
      },
    ],
    egress: [],
  },
};

describe("policy manifest round trips", () => {
  it("rebuilds a CiliumNetworkPolicy exactly, keeping fields the builder does not model", () => {
    const model = parsePolicy(cnp);
    const built = buildManifest(model);
    const expected = JSON.parse(JSON.stringify(cnp));

    delete expected.status;
    delete expected.metadata.managedFields;
    expect(built).toEqual(expected);
  });

  it("models what it understands", () => {
    const model = parsePolicy(cnp);

    expect(model.kind).toBe("CiliumNetworkPolicy");
    expect(model.namespace).toBe("shop");
    expect(model.description).toBe("Web tier");
    expect(model.specExtra).toEqual({ enableDefaultDeny: { egress: false } });
    const [first, second] = model.sections.ingress.rules;

    expect(first.peers.map((peer) => peer.type)).toEqual(["endpoint", "namespace"]);
    expect(first.peers[1].namespaceName).toBe("monitoring");
    expect(first.extra).toEqual({ authentication: { mode: "required" } });
    expect(first.portRules[0].http[0]).toMatchObject({ method: "GET", path: "/api/.*", headers: ["X-Env: prod"], extra: { headerMatches: [{ name: "x", value: "y" }] } });
    expect(second.peers[0]).toMatchObject({ type: "entity", entities: ["cluster", "host"] });
    expect(second.extra).toHaveProperty("icmps");
    const cidrRule = model.sections.egress.rules[2];

    expect(cidrRule.peers.map((peer) => peer.type)).toEqual(["cidr", "cidrGroup", "raw"]);
    expect(model.sections.egressDeny.rules[0].portRules[0].ports[0]).toMatchObject({ port: "25", endPort: 26, protocol: "TCP" });
  });

  it("rebuilds a NetworkPolicy exactly", () => {
    const model = parsePolicy(networkPolicy);

    expect(model.sections.ingress.rules[0].peers.map((peer) => peer.type)).toEqual(["endpoint", "namespace", "namespace", "cidr"]);
    expect(model.sections.egress).toMatchObject({ enabled: true, rules: [] });
    const expected = JSON.parse(JSON.stringify(networkPolicy));

    delete expected.spec.egress; // an empty list says the same as none with Egress in policyTypes
    expect(buildManifest(model)).toEqual(expected);
  });

  it("keeps policyTypes left out when Kubernetes would imply the same", () => {
    const policy = { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "a", namespace: "n" }, spec: { podSelector: {}, ingress: [{}] } };
    const model = parsePolicy(policy);

    expect(model.sections.ingress.enabled).toBe(true);
    expect(buildManifest(model)).toEqual(policy);
  });

  it("round-trips default-deny forms", () => {
    const emptyRule = { apiVersion: "cilium.io/v2", kind: "CiliumNetworkPolicy", metadata: { name: "d", namespace: "n" }, spec: { endpointSelector: {}, ingress: [{}], egress: [] } };
    const model = parsePolicy(emptyRule);

    expect(model.sections.ingress).toMatchObject({ enabled: true, rules: [], emptyForm: "emptyRule" });
    expect(model.sections.egress).toMatchObject({ enabled: true, rules: [], emptyForm: "list" });
    expect(buildManifest(model)).toEqual(emptyRule);
  });

  it("edits a spec inside `specs` and keeps the others", () => {
    const policy = {
      apiVersion: "cilium.io/v2",
      kind: "CiliumClusterwideNetworkPolicy",
      metadata: { name: "multi" },
      specs: [{ endpointSelector: { matchLabels: { a: "1" } }, ingress: [{ fromEntities: ["world"] }] }, { nodeSelector: {}, ingress: [{ fromEntities: ["cluster"] }] }],
    };
    const model = parsePolicy(policy);
    const edited = { ...model, selector: { matchLabels: { a: "2" }, matchExpressions: [] } };
    const built = buildManifest(edited);

    expect(built.spec).toBeUndefined();
    expect(built.specs[0].endpointSelector).toEqual({ matchLabels: { a: "2" } });
    expect(built.specs[1]).toEqual(policy.specs[1]);
  });

  it("parses a host policy's node selector", () => {
    const model = parsePolicy({ apiVersion: "cilium.io/v2", kind: "CiliumClusterwideNetworkPolicy", metadata: { name: "host" }, spec: { nodeSelector: { matchLabels: { role: "worker" } }, ingress: [{ fromEntities: ["cluster"] }] } });

    expect(model.subject).toBe("nodes");
    expect(buildManifest(model).spec.nodeSelector).toEqual({ matchLabels: { role: "worker" } });
    expect(buildManifest(model).metadata.namespace).toBeUndefined();
  });

  it("refuses what is not a policy", () => {
    expect(() => parsePolicy({ kind: "Service" })).toThrow(PolicyParseError);
  });

  it("drops the identity when renamed, so the result can be created", () => {
    const model = { ...parsePolicy(cnp), name: "web-copy" };
    const built = buildManifest(model);

    expect(built.metadata).toEqual({ name: "web-copy", namespace: "shop", labels: { team: "a" } });
  });

  it("builds a new Cilium policy from the model", () => {
    let model: PolicyModel = { ...newPolicyModel("CiliumNetworkPolicy", "shop"), name: "new", selector: { matchLabels: { app: "web" }, matchExpressions: [] } };

    model = addRuleWithPeer(model, "ingress", "namespace");
    const ruleId = model.sections.ingress.rules[0].id;

    model = updateSection(model, "ingress", (section) => ({
      ...section,
      rules: section.rules.map((rule) => ({
        ...rule,
        peers: rule.peers.map((peer) => ({ ...peer, namespaceName: "monitoring", podSelector: { matchLabels: { app: "prom" }, matchExpressions: [{ key: "x", operator: "Exists", values: ["ignored"] }] } })),
        portRules: [{ ...newPortRule([newPort("9090", "TCP")]), http: [{ id: "h", method: "GET", path: "/metrics", headers: [] }] }],
      })),
    }));
    model = addPeerToRule(model, "ingress", ruleId, "cidr"); // incompatible: becomes a new rule after it

    expect(model.sections.ingress.rules).toHaveLength(2);
    const built = buildManifest(model);

    expect(built).toEqual({
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: { name: "new", namespace: "shop" },
      spec: {
        endpointSelector: { matchLabels: { app: "web" } },
        ingress: [
          {
            fromEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "monitoring", app: "prom" }, matchExpressions: [{ key: "x", operator: "Exists" }] }],
            toPorts: [{ ports: [{ port: "9090", protocol: "TCP" }], rules: { http: [{ method: "GET", path: "/metrics" }] } }],
          },
          { fromCIDR: [""] },
        ],
      },
    });
  });

  it("writes the same model as a NetworkPolicy and leaves out what it cannot express", () => {
    let model: PolicyModel = { ...newPolicyModel("CiliumNetworkPolicy", "shop"), name: "np" };

    model = addRuleWithPeer(model, "egress", "namespace");
    model = updateSection(model, "egress", (section) => ({ ...section, rules: section.rules.map((rule) => ({ ...rule, peers: rule.peers.map((peer) => ({ ...peer, namespaceName: "data" })), portRules: [newPortRule([newPort("5432", "TCP")])] })) }));
    model = addRuleWithPeer(model, "egress", "fqdn");
    model = changeKind(model, "NetworkPolicy");

    expect(buildManifest(model)).toEqual({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "np", namespace: "shop" },
      spec: {
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [{ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "data" } } }], ports: [{ protocol: "TCP", port: 5432 }] }, {}],
      },
    });
    expect(policyModelIssues(model, { cidrGroups: true }).some((issue) => issue.message.includes("FQDN peers are not supported"))).toBe(true);
  });

  it("drops Cilium-only extras when a Cilium policy becomes a NetworkPolicy", () => {
    const model = changeKind(parsePolicy(cnp), "NetworkPolicy");
    const built = buildManifest(model);

    expect(built.spec.enableDefaultDeny).toBeUndefined();
    expect(built.spec.ingress[0].authentication).toBeUndefined();
    expect(built.spec.egressDeny).toBeUndefined();
    expect(built.metadata.resourceVersion).toBeUndefined();
  });

  it("reorders rules", () => {
    let model = addRuleWithPeer(addRuleWithPeer(newPolicyModel(), "egress", "entity"), "egress", "fqdn");

    model = moveRule(model, "egress", 1, 0);
    expect(model.sections.egress.rules.map((rule) => rule.peers[0].type)).toEqual(["fqdn", "entity"]);
    expect(moveRule(model, "egress", 5, 0).sections.egress.rules).toBe(model.sections.egress.rules);
    expect(moveRule(model, "egress", 0, 99).sections.egress.rules.map((rule) => rule.peers[0].type)).toEqual(["entity", "fqdn"]);
  });
});

describe("policy model issues", () => {
  it("flags rules Cilium would refuse and invalid values", () => {
    const peers: Peer[] = [
      { id: "1", type: "endpoint", selector: { matchLabels: {}, matchExpressions: [{ key: "a", operator: "In", values: [] }] } },
      { id: "2", type: "cidr", cidr: "10.0.0.0/8", except: ["192.168.0.0/16"] },
    ];
    const model: PolicyModel = {
      ...newPolicyModel(),
      name: "Bad_Name",
      sections: {
        ...newPolicyModel().sections,
        ingress: { enabled: true, rules: [{ ...newRule(peers), portRules: [{ ...newPortRule([newPort("70000", "UDP")]), http: [{ id: "h", method: "GET", path: "/", headers: [] }] }] }] },
      },
    };
    const messages = policyModelIssues(model, { cidrGroups: false }).map((issue) => issue.message);

    expect(messages.some((message) => message.startsWith("Name:"))).toBe(true);
    expect(messages.some((message) => message.includes("combining Endpoints and CIDR"))).toBe(true);
    expect(messages.some((message) => message.includes("needs at least one value"))).toBe(true);
    expect(messages.some((message) => message.includes("not inside 10.0.0.0/8"))).toBe(true);
    expect(messages.some((message) => message.includes("out of range"))).toBe(true);
    expect(messages.some((message) => message.includes("HTTP rules need TCP"))).toBe(true);
  });

  it("accepts a well-formed policy", () => {
    expect(policyModelIssues(parsePolicy(cnp), { cidrGroups: true }).filter((issue) => issue.level === "error")).toEqual([]);
  });
});

const ids = (model: PolicyModel, context = {}) => policySafetyFindings(model, context).map((finding) => finding.id);

describe("policy safety checks", () => {
  const base: PolicyModel = { ...newPolicyModel("CiliumNetworkPolicy", "shop"), name: "p", selector: { matchLabels: { app: "web" }, matchExpressions: [] } };

  it("warns when egress is restricted without DNS, and the fix allows it", () => {
    const model = addRuleWithPeer(base, "egress", "entity");

    expect(ids(model)).toContain("dns-blocked");
    const fixed = allowKubeDns(model);

    expect(ids(fixed)).not.toContain("dns-blocked");
    expect(ids(fixed)).not.toContain("dns-tcp");
    expect(buildManifest(fixed).spec.egress[1]).toEqual({
      toEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s:k8s-app": "kube-dns" } }],
      toPorts: [{ ports: [{ port: "53", protocol: "UDP" }, { port: "53", protocol: "TCP" }], rules: { dns: [{ matchPattern: "*" }] } }],
    });
  });

  it("recognises DNS allowed over UDP only, and through the cluster entity", () => {
    const udpOnly = parsePolicy({
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: { name: "a", namespace: "shop" },
      spec: { endpointSelector: { matchLabels: { app: "x" } }, egress: [{ toEndpoints: [{ matchLabels: { "io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns" } }], toPorts: [{ ports: [{ port: "53", protocol: "UDP" }] }] }] },
    });

    expect(ids(udpOnly)).toContain("dns-tcp");
    expect(ids(udpOnly)).not.toContain("dns-blocked");

    const cluster = parsePolicy({ apiVersion: "cilium.io/v2", kind: "CiliumNetworkPolicy", metadata: { name: "a", namespace: "shop" }, spec: { endpointSelector: { matchLabels: { app: "x" } }, egress: [{ toEntities: ["cluster"] }] } });

    expect(ids(cluster)).not.toContain("dns-blocked");
    expect(ids(cluster)).not.toContain("apiserver-blocked");
  });

  it("does not count a same-namespace endpoint selector as reaching kube-dns", () => {
    const model = parsePolicy({ apiVersion: "cilium.io/v2", kind: "CiliumNetworkPolicy", metadata: { name: "a", namespace: "shop" }, spec: { endpointSelector: {}, egress: [{ toEndpoints: [{ matchLabels: { "k8s-app": "kube-dns" } }] }] } });

    expect(ids(model)).toContain("dns-blocked");
  });

  it("checks NetworkPolicy egress for DNS", () => {
    const blocked = parsePolicy({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "a", namespace: "shop" }, spec: { podSelector: { matchLabels: { a: "b" } }, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: {} }] }] } });

    expect(ids(blocked)).toContain("dns-blocked");
    expect(ids(allowKubeDns(blocked))).not.toContain("dns-blocked");
    expect(buildManifest(allowKubeDns(blocked)).spec.egress[1]).toEqual({
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
      ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
    });
  });

  it("warns about toFQDNs without a DNS rule, and about names the DNS rules do not cover", () => {
    const withFqdn = parsePolicy({
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: { name: "a", namespace: "shop" },
      spec: { endpointSelector: { matchLabels: { app: "x" } }, egress: [{ toFQDNs: [{ matchName: "api.example.com" }] }] },
    });

    expect(ids(withFqdn)).toContain("fqdn-without-dns-rule");
    const fixed = allowKubeDns(withFqdn);

    expect(ids(fixed)).not.toContain("fqdn-without-dns-rule");
    expect(ids(fixed)).not.toContain("fqdn-not-covered");

    const narrow = parsePolicy({
      ...buildManifest(fixed),
      spec: { ...buildManifest(fixed).spec, egress: [{ toFQDNs: [{ matchName: "api.example.com" }] }, { toEntities: ["cluster"], toPorts: [{ ports: [{ port: "53" }], rules: { dns: [{ matchPattern: "*.internal" }] } }] }] },
    });

    expect(ids(narrow)).toContain("fqdn-not-covered");
  });

  it("matches DNS patterns as Cilium does", () => {
    expect(dnsPatternMatches("*", "anything.example.com")).toBe(true);
    expect(dnsPatternMatches("*.example.com", "api.example.com")).toBe(true);
    expect(dnsPatternMatches("*.example.com", "example.org")).toBe(false);
    expect(dnsPatternMatches("api.example.com.", "API.example.com")).toBe(true);
  });

  it("warns about empty selectors, system namespaces and default deny", () => {
    const clusterwide: PolicyModel = { ...newPolicyModel("CiliumClusterwideNetworkPolicy"), name: "all", sections: { ...newPolicyModel().sections, ingress: { enabled: true, rules: [] } } };
    const findings = policySafetyFindings(clusterwide);

    expect(findings[0]).toMatchObject({ id: "empty-selector", level: "danger" });
    expect(findings.map((finding) => finding.id)).toContain("system-namespace");
    expect(findings.map((finding) => finding.id)).toContain("default-deny-ingress");

    expect(ids({ ...base, namespace: "kube-system" })).toContain("system-namespace");
    expect(ids({ ...base, namespace: "cilium-test" }, { ciliumNamespace: "cilium-test" })).toContain("system-namespace");
  });

  it("uses real endpoints to tell whether system pods are selected", () => {
    const endpoints = endpointsFrom({
      pods: [
        { metadata: { name: "coredns-1", namespace: "kube-system", labels: { "k8s-app": "kube-dns" } }, spec: {} },
        { metadata: { name: "web-1", namespace: "shop", labels: { app: "web" } }, spec: {} },
      ],
      namespaces: [],
      ciliumEndpoints: [],
      identities: [],
    });
    const clusterwide: PolicyModel = { ...newPolicyModel("CiliumClusterwideNetworkPolicy"), name: "c", selector: { matchLabels: { "k8s-app": "kube-dns" }, matchExpressions: [] } };

    expect(ids(clusterwide, { endpoints })).toContain("system-namespace");
    expect(ids({ ...clusterwide, selector: { matchLabels: { app: "web" }, matchExpressions: [] } }, { endpoints })).not.toContain("system-namespace");
  });

  it("warns about blocking the API server, and about deny rules with world, all or the API server", () => {
    const egressOnlyWorld = addRuleWithPeer(base, "egress", "fqdn");

    expect(ids(egressOnlyWorld)).toContain("apiserver-blocked");

    const denyAll = parsePolicy({
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: { name: "a", namespace: "shop" },
      spec: { endpointSelector: { matchLabels: { app: "x" } }, egressDeny: [{ toEntities: ["all"] }], ingressDeny: [{ fromEntities: ["world"] }] },
    });
    const found = policySafetyFindings(denyAll);

    expect(found.map((finding) => finding.id)).toEqual(expect.arrayContaining(["deny-all-egressDeny", "deny-world-ingressDeny", "apiserver-denied", "dns-denied"]));
    expect(found[0].level).toBe("danger");
  });

  it("warns about CIDR rules overlapping pod CIDRs, but not about 0.0.0.0/0 or a covering exception", () => {
    const model = parsePolicy({
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: { name: "a", namespace: "shop" },
      spec: {
        endpointSelector: { matchLabels: { app: "x" } },
        ingress: [{ fromCIDR: ["10.0.0.0/8"] }, { fromCIDR: ["0.0.0.0/0"] }, { fromCIDRSet: [{ cidr: "10.244.0.0/16", except: ["10.244.0.0/16"] }] }],
      },
    });
    const overlaps = ids(model, { podCIDRs: ["10.244.1.0/24"] }).filter((id) => id.startsWith("cidr-overlap"));

    expect(overlaps).toEqual(["cidr-overlap-10.0.0.0/8-10.244.1.0/24"]);
  });

  it("reads port coverage with ranges, ANY and named ports", () => {
    const rule = { ...newRule(), portRules: [newPortRule([{ ...newPort("50", "ANY"), endPort: 60 }])] };

    expect(portsAllow(rule, 53, "UDP")).toBe(true);
    expect(portsAllow({ ...newRule(), portRules: [newPortRule([newPort("dns", "UDP")])] }, 53, "UDP", ["dns"])).toBe(true);
    expect(portsAllow({ ...newRule(), portRules: [newPortRule([newPort("53", "TCP")])] }, 53, "UDP")).toBe(false);
    expect(portsAllow(newRule(), 53, "UDP")).toBe(true);
  });
});

describe("policy summaries", () => {
  it("summarises every rule readably", () => {
    const summary = summarizeModel(parsePolicy(cnp));

    expect(summary.subject).toBe("endpoints app=web, tier in (front) in shop");
    const ingress = summary.sections.find((section) => section.direction === "ingress")!;

    expect(ingress.rules[0].text).toBe("Allow from endpoints app=lb in shop or all pods in namespace monitoring on 80/TCP (HTTP GET /api/.* with X-Env: prod) [also: authentication]");
    const deny = summary.sections.find((section) => section.direction === "egressDeny")!;

    expect(deny.rules[0].text).toBe("Deny to entity world on 25-26/TCP");
    expect(summary.enforces).toEqual({ ingress: true, egress: true });
  });

  it("calls an empty Cilium rule what it is", () => {
    const model = addRule(newPolicyModel(), "ingress");

    expect(summarizeModel(model).sections[0].rules[0]).toMatchObject({ matchesNothing: true, text: "Allow nothing (an empty rule)" });
  });
});


describe("policy selection and status", () => {
  const sources = {
    pods: [
      { metadata: { name: "web-1", namespace: "shop", labels: { app: "web", tier: "front" } }, spec: { nodeName: "n1", serviceAccountName: "web" } },
      { metadata: { name: "worker-1", namespace: "shop", labels: { app: "worker" } }, spec: {} },
      { metadata: { name: "host-agent", namespace: "kube-system", labels: { app: "agent" } }, spec: { hostNetwork: true } },
      { metadata: { name: "done", namespace: "shop", labels: { app: "web", tier: "front" } }, spec: {}, status: { phase: "Succeeded" } },
    ],
    namespaces: [{ metadata: { name: "shop", labels: { env: "prod" } } }],
    ciliumEndpoints: [
      { metadata: { name: "web-1", namespace: "shop" }, status: { identity: { id: 1234 }, policy: { ingress: { enforcing: true }, egress: { enforcing: false } }, state: "ready" } },
      { metadata: { name: "orphan", namespace: "other" }, status: { identity: { id: 77 } } },
    ],
    identities: [{ metadata: { name: "77" }, "security-labels": { "k8s:app": "orphan", "k8s:io.kubernetes.pod.namespace": "other" } }],
  };

  it("lists endpoints from pods and CiliumEndpoints", () => {
    const endpoints = endpointsFrom(sources);

    expect(endpoints.map((endpoint) => endpoint.key)).toEqual(["shop/web-1", "shop/worker-1", "other/orphan"]);
    expect(endpoints[0]).toMatchObject({ identity: 1234, managed: true, enforcement: { ingress: true, egress: false, state: "ready" } });
    expect(endpoints[0].labels).toMatchObject({ "io.kubernetes.pod.namespace": "shop", "io.cilium.k8s.policy.serviceaccount": "web", "io.cilium.k8s.namespace.labels.env": "prod" });
    expect(endpoints[1].managed).toBe(false);
    expect(endpoints[2].labels).toMatchObject({ app: "orphan" });
  });

  it("matches policies to endpoints, Cilium prefixes included", () => {
    const endpoints = endpointsFrom(sources);
    const model = parsePolicy(cnp);

    expect(endpoints.filter((endpoint) => modelSelectsEndpoint(model, endpoint)).map((endpoint) => endpoint.name)).toEqual(["web-1"]);
    const clusterwide = parsePolicy({ apiVersion: "cilium.io/v2", kind: "CiliumClusterwideNetworkPolicy", metadata: { name: "c" }, spec: { endpointSelector: { matchLabels: { "k8s:app": "orphan" } } } });

    expect(endpoints.filter((endpoint) => modelSelectsEndpoint(clusterwide, endpoint)).map((endpoint) => endpoint.name)).toEqual(["orphan"]);
    const ns = parsePolicy({ ...networkPolicy, metadata: { name: "x", namespace: "shop" }, spec: { podSelector: {} } });

    expect(endpoints.filter((endpoint) => modelSelectsEndpoint(ns, endpoint)).map((endpoint) => endpoint.name)).toEqual(["web-1", "worker-1"]);
  });

  it("reads the Valid condition and node status", () => {
    expect(policyStatusOf(cnp).valid).toEqual({ ok: true, message: "Policy validation succeeded" });
    expect(policyStatusOf({ status: { nodes: { n1: { ok: true, enforcing: true }, n2: { ok: false, error: "bad" } } } }).nodes).toEqual({ total: 2, ok: 1, enforcing: 1, errors: ["n2: bad"] });
    expect(policyStatusOf({}).valid).toBeUndefined();
  });

  it("groups coverage by namespace and counts unprotected endpoints", () => {
    const endpoints = endpointsFrom(sources);
    const ref = policyRefOf(cnp);
    const coverage = coverageByNamespace(endpoints, new Map([["shop/web-1", [ref.key]]]), [ref]);

    expect(coverage.map((group) => [group.namespace, group.unprotected])).toEqual([
      ["other", 1],
      ["shop", 1],
    ]);
    expect(coverage[1].rows[0].policies[0].name).toBe("web");
  });
});

const endpoint = (labels: string[], extra: Partial<FlowEndpoint> = {}): FlowEndpoint => ({ labels, ...extra });

const edge = (from: FlowEndpoint, to: FlowEndpoint, ports: string[], forwarded = 1, dropped = 0): FlowEdge => ({
  from: from.podName ?? from.ip ?? "x",
  to: to.podName ?? to.ip ?? to.names?.[0] ?? "y",
  fromEndpoint: from,
  toEndpoint: to,
  forwarded,
  dropped,
  other: 0,
  ports,
  protocols: [],
  dropReasons: dropped > 0 ? ["POLICY_DENIED"] : [],
  lastSeen: "2026-01-01T00:00:00Z",
});

describe("flow-based suggestions", () => {
  const model: PolicyModel = { ...newPolicyModel("CiliumNetworkPolicy", "shop"), name: "web", selector: { matchLabels: { app: "web" }, matchExpressions: [] } };
  const web = endpoint(["k8s:app=web", "k8s:pod-template-hash=abc", "k8s:io.kubernetes.pod.namespace=shop"], { namespace: "shop", podName: "web-1" });
  const lb = endpoint(["k8s:app=lb", "k8s:io.kubernetes.pod.namespace=shop"], { namespace: "shop", podName: "lb-1" });
  const dns = endpoint(["k8s:k8s-app=kube-dns", "k8s:io.kubernetes.pod.namespace=kube-system", "k8s:pod-template-hash=x"], { namespace: "kube-system", podName: "coredns-1" });
  const external = endpoint(["reserved:world"], { ip: "203.0.113.5", names: ["api.example.com."] });
  const apiserver = endpoint(["reserved:kube-apiserver", "reserved:host"], { ip: "10.0.0.1" });

  const edges = [edge(lb, web, ["80/TCP"], 5), edge(lb, web, ["443/TCP"], 1, 2), edge(web, dns, ["53/UDP"], 10), edge(web, external, ["443/TCP"], 3), edge(web, apiserver, ["6443/TCP"], 2)];

  it("groups flows by direction and peer, with ports and counts", () => {
    const suggestions = suggestRules(model, edges);
    const byLabel = Object.fromEntries(suggestions.map((suggestion) => [`${suggestion.direction} ${suggestion.peerLabel}`, suggestion]));

    expect(Object.keys(byLabel).sort()).toEqual(["egress entity kube-apiserver", "egress name api.example.com", "egress pods k8s-app=kube-dns in namespace kube-system", "ingress endpoints app=lb in shop"]);
    expect(byLabel["ingress endpoints app=lb in shop"]).toMatchObject({ forwarded: 6, dropped: 2, ports: [{ port: "80", protocol: "TCP" }, { port: "443", protocol: "TCP" }], dropReasons: ["POLICY_DENIED"] });
  });

  it("never suggests volatile labels", () => {
    expect(stableWorkloadLabels({ app: "web", "pod-template-hash": "abc", "io.kubernetes.pod.namespace": "shop" })).toEqual({ app: "web" });
    expect(stableWorkloadLabels({ "app.kubernetes.io/name": "x", "app.kubernetes.io/instance": "y", team: "z" })).toEqual({ "app.kubernetes.io/name": "x", "app.kubernetes.io/instance": "y" });
    expect(stableWorkloadLabels({ team: "z", "controller-revision-hash": "1" })).toEqual({ team: "z" });
  });

  it("adds only the picked suggestions, and DNS when an FQDN is picked", () => {
    const suggestions = suggestRules(model, edges);
    const fqdn = suggestions.find((suggestion) => suggestion.peer.type === "fqdn")!;
    const next = applySuggestions(model, [fqdn]);
    const spec = buildManifest(next).spec;

    expect(spec.ingress).toBeUndefined();
    expect(spec.egress[0]).toEqual({ toFQDNs: [{ matchName: "api.example.com" }], toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] });
    expect(spec.egress[1].toPorts[0].rules).toEqual({ dns: [{ matchPattern: "*" }] });
    expect(policySafetyFindings(next).map((finding) => finding.id)).not.toContain("fqdn-without-dns-rule");
  });

  it("suggests addresses instead of entities and names for a NetworkPolicy", () => {
    const np = changeKind(model, "NetworkPolicy");
    const labels = suggestRules(np, edges).map((suggestion) => `${suggestion.direction} ${suggestion.peerLabel}`);

    expect(labels).toEqual(expect.arrayContaining(["egress 203.0.113.5/32", "egress 10.0.0.1/32"]));
  });

  it("builds the Hubble filter from the selector", () => {
    expect(flowFilterFor({ ...model, selector: { matchLabels: { "k8s:app": "web", tier: "front" }, matchExpressions: [] } }, { since: "15m" })).toEqual({
      since: "15m",
      last: 2000,
      namespace: "shop",
      labels: "app=web,tier=front",
    });
  });
});
