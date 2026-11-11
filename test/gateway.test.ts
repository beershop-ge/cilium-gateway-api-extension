import { describe, expect, it } from "vitest";
import type { Json } from "../src/common/json";
import type { ResourceType } from "../src/kube/resource-types";
import type { Snapshot } from "../src/kube/snapshot";
import { bundleInfoOf, fieldAvailability, gatewayClassForDocument, gatewayFeaturesOf, supportedFeaturesOf } from "../src/gateway/features";
import {
  attachRoute,
  backendRefFor,
  changeListenerProtocol,
  detachRoute,
  detachRouteFromListener,
  editField,
  headerListToMap,
  headerMapToList,
  newDocument,
  newListener,
  newReferenceGrant,
  removeAt,
  trafficShares,
  uniqueName,
} from "../src/gateway/manifest";
import { gatewayStatusOf, routeParentStatusesOf, routesOfListener } from "../src/gateway/status";
import {
  hostnameError,
  hostnamesIntersect,
  inventoryFromSnapshot,
  type Inventory,
  issuesUnder,
  listenerAdmits,
  listenerConflicts,
  referenceAllowed,
  suggestedGrants,
  validateGateway,
  validateGatewayClass,
  validateReferenceGrant,
  validateRoute,
} from "../src/gateway/validation";
import { buildTopology, fromClusterSnapshot } from "../src/gateway-map/topology";

const G = "gateway.networking.k8s.io";

const namespace = (name: string, labels: Record<string, string> = {}) => ({ metadata: { name, labels: { "kubernetes.io/metadata.name": name, ...labels } } });

const gateway = (listeners: Json[], ns = "infra", name = "gw"): Json => ({
  apiVersion: `${G}/v1`,
  kind: "Gateway",
  metadata: { name, namespace: ns },
  spec: { gatewayClassName: "cilium", listeners },
});

const inventory: Inventory = {
  namespaces: [namespace("infra"), namespace("apps", { team: "a" }), namespace("other")],
  services: [
    { metadata: { name: "web", namespace: "apps" }, spec: { ports: [{ port: 80, name: "http" }, { port: 8443 }] } },
    { metadata: { name: "db", namespace: "other" }, spec: { ports: [{ port: 5432 }] } },
  ],
  secrets: [
    { metadata: { name: "tls-cert", namespace: "infra" }, type: "kubernetes.io/tls", keys: ["tls.crt", "tls.key"] },
    { metadata: { name: "opaque", namespace: "infra" }, type: "Opaque", keys: ["x"] },
    { metadata: { name: "shared-cert", namespace: "certs" }, type: "kubernetes.io/tls", keys: ["tls.crt", "tls.key"] },
  ],
  gatewayClasses: [{ metadata: { name: "cilium" }, spec: { controllerName: "io.cilium/gateway-controller" } }],
  gateways: [
    gateway([
      { name: "http", protocol: "HTTP", port: 80, allowedRoutes: { namespaces: { from: "All" } } },
      { name: "https", protocol: "HTTPS", port: 443, hostname: "*.example.com", tls: { mode: "Terminate", certificateRefs: [{ name: "tls-cert" }] }, allowedRoutes: { namespaces: { from: "Selector", selector: { matchLabels: { team: "a" } } } } },
      { name: "same", protocol: "HTTP", port: 8080 },
    ]),
  ],
  referenceGrants: [],
};

const route = (spec: Json, ns = "apps", kind = "HTTPRoute"): Json => ({ apiVersion: `${G}/v1`, kind, metadata: { name: "r", namespace: ns }, spec });

const messages = (issues: { message: string; severity: string }[], severity = "error") => issues.filter((issue) => issue.severity === severity).map((issue) => issue.message);

describe("hostnames", () => {
  it("intersects exact and wildcard hostnames as the Gateway API defines", () => {
    expect(hostnamesIntersect(undefined, "a.example.com")).toBe(true);
    expect(hostnamesIntersect("a.example.com", "a.example.com")).toBe(true);
    expect(hostnamesIntersect("a.example.com", "b.example.com")).toBe(false);
    expect(hostnamesIntersect("*.example.com", "a.example.com")).toBe(true);
    expect(hostnamesIntersect("*.example.com", "a.b.example.com")).toBe(true);
    expect(hostnamesIntersect("*.example.com", "example.com")).toBe(false);
    expect(hostnamesIntersect("a.example.com", "*.example.com")).toBe(true);
    expect(hostnamesIntersect("*.example.com", "*.foo.example.com")).toBe(true);
    expect(hostnamesIntersect("*.example.com", "*.example.org")).toBe(false);
  });

  it("rejects IP addresses and malformed names", () => {
    expect(hostnameError("www.example.com")).toBeUndefined();
    expect(hostnameError("*.example.com")).toBeUndefined();
    expect(hostnameError("10.0.0.1")).toMatch(/IP/);
    expect(hostnameError("Bad_Name")).toBeDefined();
  });
});

describe("listener conflicts", () => {
  it("finds duplicate names, protocol conflicts and hostname conflicts", () => {
    const issues = listenerConflicts([
      { name: "a", protocol: "HTTP", port: 80 },
      { name: "a", protocol: "HTTP", port: 81 },
      { name: "b", protocol: "HTTPS", port: 80 },
      { name: "c", protocol: "HTTP", port: 80 },
    ]);

    expect(issues.some((issue) => /already used/.test(issue.message))).toBe(true);
    expect(issues.some((issue) => /ProtocolConflict/.test(issue.message))).toBe(true);
    expect(issues.some((issue) => /HostnameConflict/.test(issue.message))).toBe(true);
  });

  it("allows HTTPS and TLS, or TCP and UDP, on one port, and distinct hostnames", () => {
    expect(
      listenerConflicts([
        { name: "a", protocol: "HTTPS", port: 443, hostname: "a.example.com" },
        { name: "b", protocol: "TLS", port: 443, hostname: "b.example.com" },
        { name: "c", protocol: "TCP", port: 53 },
        { name: "d", protocol: "UDP", port: 53 },
        { name: "e", protocol: "HTTP", port: 80, hostname: "a.example.com" },
        { name: "f", protocol: "HTTP", port: 80, hostname: "b.example.com" },
      ]),
    ).toEqual([]);
  });
});

describe("allowedRoutes", () => {
  const listener = (allowedRoutes: Json, protocol = "HTTP") => ({ name: "l", protocol, port: 80, allowedRoutes });

  it("admits by namespace: Same, All, Selector", () => {
    expect(listenerAdmits(listener(undefined), "infra", { kind: "HTTPRoute", namespace: "apps" }, {}).admitted).toBe(false);
    expect(listenerAdmits(listener(undefined), "infra", { kind: "HTTPRoute", namespace: "infra" }, {}).admitted).toBe(true);
    expect(listenerAdmits(listener({ namespaces: { from: "All" } }), "infra", { kind: "HTTPRoute", namespace: "apps" }, {}).admitted).toBe(true);
    const selector = listener({ namespaces: { from: "Selector", selector: { matchLabels: { team: "a" } } } });

    expect(listenerAdmits(selector, "infra", { kind: "HTTPRoute", namespace: "apps" }, { team: "a" }).admitted).toBe(true);
    expect(listenerAdmits(selector, "infra", { kind: "HTTPRoute", namespace: "apps" }, { team: "b" }).admitted).toBe(false);
  });

  it("admits by kind: protocol defaults and explicit kinds", () => {
    expect(listenerAdmits(listener({ namespaces: { from: "All" } }, "TCP"), "infra", { kind: "HTTPRoute", namespace: "x" }, {}).admitted).toBe(false);
    expect(listenerAdmits(listener({ namespaces: { from: "All" } }, "TCP"), "infra", { kind: "TCPRoute", namespace: "x" }, {}).admitted).toBe(true);
    expect(listenerAdmits(listener({ namespaces: { from: "All" }, kinds: [{ kind: "GRPCRoute" }] }), "infra", { kind: "HTTPRoute", namespace: "x" }, {}).admitted).toBe(false);
  });
});

describe("ReferenceGrants", () => {
  const grant = newReferenceGrant({}, { group: G, kind: "HTTPRoute", namespace: "apps" }, { group: "", kind: "Service", namespace: "other", name: "db" });

  it("builds a grant in the target namespace", () => {
    expect(grant.metadata.namespace).toBe("other");
    expect(grant.spec.from).toEqual([{ group: G, kind: "HTTPRoute", namespace: "apps" }]);
    expect(grant.spec.to).toEqual([{ group: "", kind: "Service", name: "db" }]);
    expect(grant.metadata.name).toMatch(/^[a-z0-9-]+$/);
  });

  it("decides whether a reference is allowed", () => {
    const from = { group: G, kind: "HTTPRoute", namespace: "apps" };
    const to = { group: "", kind: "Service", namespace: "other", name: "db" };

    expect(referenceAllowed([], from, to)).toBe(false);
    expect(referenceAllowed([grant], from, to)).toBe(true);
    expect(referenceAllowed([grant], from, { ...to, name: "other-svc" })).toBe(false);
    expect(referenceAllowed([], from, { ...to, namespace: "apps" })).toBe(true);
    expect(referenceAllowed([grant], { ...from, kind: "GRPCRoute" }, to)).toBe(false);
  });

  it("validates a grant's sources and targets", () => {
    expect(messages(validateReferenceGrant({ kind: "ReferenceGrant", metadata: { name: "g", namespace: "other" }, spec: {} }, inventory))).toHaveLength(2);
    expect(messages(validateReferenceGrant(grant, inventory))).toEqual([]);
  });
});

describe("Gateway validation", () => {
  it("accepts a valid Gateway", () => {
    expect(messages(validateGateway(inventory.gateways![0], inventory))).toEqual([]);
  });

  it("checks the class, certificates, ports and TLS mode", () => {
    const issues = validateGateway(
      {
        ...gateway([
          { name: "a", protocol: "HTTPS", port: 443, tls: { mode: "Terminate", certificateRefs: [{ name: "missing" }] } },
          { name: "b", protocol: "HTTPS", port: 444, tls: { mode: "Terminate", certificateRefs: [] } },
          { name: "c", protocol: "TLS", port: 445, tls: { mode: "Passthrough", certificateRefs: [{ name: "tls-cert" }] } },
          { name: "d", protocol: "HTTP", port: 70000 },
          { name: "e", protocol: "TCP", port: 9000, hostname: "x.example.com" },
          { name: "f", protocol: "HTTPS", port: 446, tls: { mode: "Terminate", certificateRefs: [{ name: "opaque" }] } },
        ]),
        spec: {
          gatewayClassName: "nope",
          listeners: undefined,
        },
      },
      inventory,
    );

    expect(messages(issues)).toContain("GatewayClass nope does not exist");

    const listenerIssues = validateGateway(
      gateway([
        { name: "a", protocol: "HTTPS", port: 443, tls: { mode: "Terminate", certificateRefs: [{ name: "missing" }] } },
        { name: "b", protocol: "HTTPS", port: 444, tls: { mode: "Terminate", certificateRefs: [] } },
        { name: "c", protocol: "TLS", port: 445, tls: { mode: "Passthrough", certificateRefs: [{ name: "tls-cert" }] } },
        { name: "d", protocol: "HTTP", port: 70000 },
        { name: "e", protocol: "TCP", port: 9000, hostname: "x.example.com" },
        { name: "f", protocol: "HTTPS", port: 446, tls: { mode: "Terminate", certificateRefs: [{ name: "opaque" }] } },
      ]),
      inventory,
    );
    const errors = messages(listenerIssues).join("\n");

    expect(errors).toMatch(/infra\/missing does not exist/);
    expect(errors).toMatch(/needs at least one certificate/);
    expect(errors).toMatch(/Passthrough listeners cannot have certificates/);
    expect(errors).toMatch(/1 to 65535/);
    expect(errors).toMatch(/TCP listeners cannot have a hostname/);
    expect(messages(listenerIssues, "warning").join("\n")).toMatch(/Opaque/);
  });

  it("requires a ReferenceGrant for a certificate in another namespace and offers one", () => {
    const issues = validateGateway(gateway([{ name: "a", protocol: "HTTPS", port: 443, tls: { mode: "Terminate", certificateRefs: [{ name: "shared-cert", namespace: "certs" }] } }]), inventory);
    const grants = suggestedGrants(issues);

    expect(messages(issues).join("\n")).toMatch(/RefNotPermitted/);
    expect(grants).toHaveLength(1);
    expect(grants[0].spec.from[0]).toEqual({ group: G, kind: "Gateway", namespace: "infra" });
    expect(grants[0].spec.to[0]).toEqual({ group: "", kind: "Secret", name: "shared-cert" });
  });

  it("does not claim anything about lists it could not read", () => {
    const issues = validateGateway(gateway([{ name: "a", protocol: "HTTPS", port: 443, tls: { mode: "Terminate", certificateRefs: [{ name: "x" }] } }]), { ...inventory, secrets: undefined });

    expect(messages(issues)).toEqual([]);
    expect(messages(issues, "info").join("")).toMatch(/could not be read/);
  });

  it("validates GatewayClass controller names", () => {
    expect(validateGatewayClass({ spec: { controllerName: "io.cilium/gateway-controller" } })).toEqual([]);
    expect(validateGatewayClass({ spec: { controllerName: "no-slash" } })).toHaveLength(1);
    expect(validateGatewayClass({ spec: {} })).toHaveLength(1);
  });
});

describe("route validation", () => {
  it("accepts a valid route", () => {
    const issues = validateRoute(route({ parentRefs: [{ name: "gw", namespace: "infra", sectionName: "http" }], hostnames: ["a.example.com"], rules: [{ backendRefs: [{ name: "web", port: 80 }] }] }), inventory);

    expect(messages(issues)).toEqual([]);
    expect(messages(issues, "warning")).toEqual([]);
  });

  it("checks Gateways, sections and ports", () => {
    expect(messages(validateRoute(route({ parentRefs: [{ name: "nope", namespace: "infra" }], rules: [] }), inventory)).join()).toMatch(/does not exist/);
    expect(messages(validateRoute(route({ parentRefs: [{ name: "gw", namespace: "infra", sectionName: "zzz" }], rules: [] }), inventory)).join()).toMatch(/no listener named/);
    expect(messages(validateRoute(route({ parentRefs: [{ name: "gw", namespace: "infra", port: 9999 }], rules: [] }), inventory)).join()).toMatch(/NoMatchingParent/);
  });

  it("checks allowedRoutes and hostname intersection", () => {
    const notAllowed = validateRoute(route({ parentRefs: [{ name: "gw", namespace: "infra", sectionName: "same" }], rules: [] }), inventory);

    expect(messages(notAllowed).join()).toMatch(/NotAllowedByListeners/);

    const fromOther = validateRoute(route({ parentRefs: [{ name: "gw", namespace: "infra", sectionName: "https" }], rules: [] }, "other"), inventory);

    expect(messages(fromOther).join()).toMatch(/does not match the namespace selector/);

    const wrongHost = validateRoute(route({ parentRefs: [{ name: "gw", namespace: "infra", sectionName: "https" }], hostnames: ["a.example.org"], rules: [] }), inventory);

    expect(messages(wrongHost).join()).toMatch(/NoMatchingListenerHostname/);
  });

  it("checks Services, ports, cross-namespace grants and weights", () => {
    const issues = validateRoute(
      route({
        parentRefs: [{ name: "gw", namespace: "infra", sectionName: "http" }],
        rules: [
          { backendRefs: [{ name: "missing", port: 80 }, { name: "web", port: 81 }, { name: "web" }] },
          { backendRefs: [{ name: "db", namespace: "other", port: 5432, weight: -1 }] },
          { backendRefs: [{ name: "web", port: 80, weight: 0 }, { name: "web", port: 8443, weight: 0 }] },
        ],
      }),
      inventory,
    );
    const errors = messages(issues).join("\n");

    expect(errors).toMatch(/apps\/missing does not exist/);
    expect(errors).toMatch(/has no port 81/);
    expect(errors).toMatch(/port is required/);
    expect(errors).toMatch(/whole number from 0 to 1000000/);
    expect(errors).toMatch(/RefNotPermitted/);
    expect(messages(issues, "warning").join()).toMatch(/weight 0/);
    expect(suggestedGrants(issues)[0].metadata.namespace).toBe("other");
    expect(issuesUnder(issues, ["spec", "rules", 1]).length).toBeGreaterThan(0);
  });

  it("accepts a cross-namespace backend once a ReferenceGrant allows it", () => {
    const grant = newReferenceGrant({}, { group: G, kind: "HTTPRoute", namespace: "apps" }, { group: "", kind: "Service", namespace: "other", name: "db" });
    const issues = validateRoute(route({ parentRefs: [{ name: "gw", namespace: "infra" }], rules: [{ backendRefs: [{ name: "db", namespace: "other", port: 5432 }] }] }), { ...inventory, referenceGrants: [grant] });

    expect(messages(issues)).toEqual([]);
  });

  it("checks filters", () => {
    const issues = validateRoute(
      route({
        parentRefs: [{ name: "gw", namespace: "infra" }],
        rules: [
          {
            matches: [{ path: { type: "Exact", value: "/a" } }],
            filters: [{ type: "RequestRedirect", requestRedirect: { scheme: "https" } }, { type: "URLRewrite", urlRewrite: { path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/" } } }],
            backendRefs: [{ name: "web", port: 80 }],
          },
        ],
      }),
      inventory,
    );
    const errors = messages(issues).join("\n");

    expect(errors).toMatch(/both redirect and rewrite/);
    expect(errors).toMatch(/cannot also have backends/);
    expect(errors).toMatch(/ReplacePrefixMatch needs/);
  });
});

describe("manifest building", () => {
  it("editField removes emptied fields and their empty parents but keeps array elements", () => {
    const doc = { spec: { rules: [{ timeouts: { request: "1s" } }] } };

    expect(editField(doc, ["spec", "rules", 0, "timeouts", "request"], "")).toEqual({ spec: { rules: [{}] } });
    expect(editField(doc, ["spec", "rules", 0], {})).toEqual({ spec: { rules: [{}] } });
    expect(removeAt({ spec: { hostnames: ["a"] } }, ["spec", "hostnames"], 0)).toEqual({ spec: {} });
  });

  it("names new listeners uniquely with sensible defaults", () => {
    const https = newListener([{ name: "https" }], { protocol: "HTTPS" });

    expect(https).toMatchObject({ name: "https-2", port: 443, protocol: "HTTPS", tls: { mode: "Terminate" } });
    expect(newListener([], { protocol: "TLS" }).tls).toEqual({ mode: "Passthrough" });
    expect(changeListenerProtocol({ name: "x", protocol: "HTTPS", hostname: "a", tls: { mode: "Terminate" } }, "TCP")).toEqual({ name: "x", protocol: "TCP" });
  });

  it("attaches and detaches routes", () => {
    const base = route({ parentRefs: [], rules: [] });
    const attached = attachRoute(base, { name: "gw", namespace: "infra", sectionName: "http" });

    expect(attached.spec.parentRefs).toEqual([{ group: G, kind: "Gateway", name: "gw", namespace: "infra", sectionName: "http" }]);
    expect(attachRoute(attached, { name: "gw", namespace: "infra", sectionName: "http" })).toBe(attached);
    expect(detachRoute(attached, { name: "gw", namespace: "infra" }).spec.parentRefs).toBeUndefined();

    const two = attachRoute(attached, { name: "gw", namespace: "infra", sectionName: "https" });
    const gw = inventory.gateways![0];

    expect(detachRouteFromListener(two, gw, gw.spec.listeners[0]).spec.parentRefs).toEqual([{ group: G, kind: "Gateway", name: "gw", namespace: "infra", sectionName: "https" }]);
  });

  it("builds backend refs and traffic shares", () => {
    expect(backendRefFor("apps", { name: "web", namespace: "apps" }, 80)).toEqual({ name: "web", port: 80 });
    expect(backendRefFor("apps", { name: "db", namespace: "other" }, 5432, 10)).toEqual({ name: "db", namespace: "other", port: 5432, weight: 10 });
    expect(trafficShares([{ weight: 90 }, { weight: 10 }])).toEqual([90, 10]);
    expect(trafficShares([{}, {}])).toEqual([50, 50]);
    expect(trafficShares([{ weight: 0 }])).toEqual([0]);
  });

  it("converts header lists", () => {
    expect(headerListToMap([{ name: "X-A", value: "1" }])).toEqual({ "X-A": "1" });
    expect(headerListToMap([])).toBeUndefined();
    expect(headerMapToList({ "X-A": "1" })).toEqual([{ name: "X-A", value: "1" }]);
  });

  it("starts new documents from what the cluster has", () => {
    const versions = { Gateway: `${G}/v1`, HTTPRoute: `${G}/v1` };
    const newGateway = newDocument("Gateway", versions, { namespace: "infra", gatewayClasses: inventory.gatewayClasses!, gateways: inventory.gateways!, existing: inventory.gateways! });

    expect(newGateway.spec.gatewayClassName).toBe("cilium");
    expect(newGateway.metadata.name).toBe("gateway");
    expect(messages(validateGateway(newGateway, inventory))).toEqual([]);

    const newRoute = newDocument("HTTPRoute", versions, { namespace: "infra", gatewayClasses: [], gateways: inventory.gateways!, existing: [] });

    expect(newRoute.spec.parentRefs).toEqual([{ group: G, kind: "Gateway", name: "gw" }]);
    expect(uniqueName("a", [{ metadata: { name: "a" } }, { metadata: { name: "a-2" } }])).toBe("a-3");
  });
});

describe("feature detection", () => {
  const schema = {
    type: "object" as const,
    properties: {
      spec: {
        type: "object" as const,
        properties: {
          rules: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                timeouts: { type: "object" as const, properties: { request: { type: "string" as const } } },
                filters: { type: "array" as const, items: { type: "object" as const, properties: { type: { type: "string" as const, enum: ["RequestHeaderModifier", "RequestRedirect", "URLRewrite"] } } } },
                matches: { type: "array" as const, items: { type: "object" as const, properties: { path: { type: "object" as const, properties: { type: { type: "string" as const, enum: ["Exact", "PathPrefix"] } } } } } },
              },
            },
          },
        },
      },
    },
  };
  const type = (kind: string, annotations?: Record<string, string>): ResourceType => ({
    id: `${kind.toLowerCase()}s.${G}`,
    group: G,
    kind,
    plural: `${kind.toLowerCase()}s`,
    singular: kind.toLowerCase(),
    shortNames: [],
    namespaced: true,
    versions: [{ name: "v1", served: true, storage: true, printerColumns: [], hasStatusSubresource: true }],
    preferredVersion: "v1",
    section: "gateway",
    title: kind,
    order: 0,
    source: "crd",
    crdAnnotations: annotations,
  });

  it("offers only what the installed schema and the class support", () => {
    const types = [type("Gateway", { "gateway.networking.k8s.io/bundle-version": "v1.2.0", "gateway.networking.k8s.io/channel": "standard" }), type("HTTPRoute")];
    const features = gatewayFeaturesOf(types, { HTTPRoute: { schema } });

    expect(features.installed.TLSRoute).toBeUndefined();
    expect(features.gateway.protocols).toEqual(["HTTP", "HTTPS"]);
    expect(features.http.pathTypes).toEqual(["Exact", "PathPrefix"]);
    expect(features.http.filterTypes.map((filter) => filter.type)).toEqual(["RequestHeaderModifier", "RequestRedirect", "URLRewrite"]);
    expect(features.http.timeouts.available).toBe(true);
    expect(features.http.retry.available).toBe(false);
    expect(features.bundle).toEqual({ version: "v1.2.0", channel: "standard", mixed: [] });

    const limited = gatewayFeaturesOf(types, { HTTPRoute: { schema } }, new Set(["HTTPRoute"]));

    expect(limited.http.timeouts.available).toBe(false);
    expect(limited.http.filterTypes.find((filter) => filter.type === "URLRewrite")?.available).toBe(false);
    expect(fieldAvailability(undefined, ["spec"], undefined, undefined).available).toBe(false);
  });

  it("reads supportedFeatures in both formats and finds the relevant class", () => {
    expect(supportedFeaturesOf({ status: { supportedFeatures: ["A", "B"] } })).toEqual(new Set(["A", "B"]));
    expect(supportedFeaturesOf({ status: { supportedFeatures: [{ name: "A" }] } })).toEqual(new Set(["A"]));
    expect(supportedFeaturesOf({ status: {} })).toBeUndefined();

    const classes = inventory.gatewayClasses!;

    expect(gatewayClassForDocument(route({ parentRefs: [{ name: "gw", namespace: "infra" }] }), classes, inventory.gateways!)).toBe(classes[0]);
    expect(gatewayClassForDocument(route({ parentRefs: [] }), classes, inventory.gateways!)).toBeUndefined();
  });

  it("reports mixed bundle versions", () => {
    const info = bundleInfoOf([type("Gateway", { "gateway.networking.k8s.io/bundle-version": "v1.2.0" }), type("HTTPRoute", { "gateway.networking.k8s.io/bundle-version": "v1.1.0" })]);

    expect(info.mixed).toEqual(["v1.2.0", "v1.1.0"]);
  });
});

describe("status", () => {
  it("summarizes a Gateway and its listeners", () => {
    const status = gatewayStatusOf({
      ...inventory.gateways![0],
      metadata: { name: "gw", namespace: "infra", generation: 2 },
      status: {
        addresses: [{ value: "10.0.0.1" }],
        conditions: [{ type: "Accepted", status: "True", observedGeneration: 2 }, { type: "Programmed", status: "True", observedGeneration: 1 }],
        listeners: [{ name: "http", attachedRoutes: 2, conditions: [{ type: "Accepted", status: "True" }, { type: "Programmed", status: "True" }, { type: "ResolvedRefs", status: "False", reason: "InvalidCertificateRef" }] }],
      },
    });

    expect(status.gateway.health).toBe("ok");
    expect(status.gateway.stale).toBe(true);
    expect(status.addresses).toEqual(["10.0.0.1"]);
    expect(status.listeners[0]).toMatchObject({ name: "http", attachedRoutes: 2, health: "error" });
    expect(status.listeners[1].health).toBe("unknown");
  });

  it("matches route parent status to parentRefs", () => {
    const parents = routeParentStatusesOf({
      ...route({ parentRefs: [{ name: "gw", namespace: "infra", sectionName: "http" }, { name: "other", namespace: "infra" }] }),
      status: {
        parents: [
          { parentRef: { name: "gw", namespace: "infra", sectionName: "http" }, controllerName: "io.cilium/gateway-controller", conditions: [{ type: "Accepted", status: "True" }, { type: "ResolvedRefs", status: "True" }] },
          { parentRef: { name: "old", namespace: "infra" }, conditions: [{ type: "Accepted", status: "False", reason: "NoMatchingParent" }] },
        ],
      },
    });

    expect(parents.map((parent) => parent.health)).toEqual(["ok", "unknown", "error"]);
    expect(parents[1].unreported).toBe(true);
    expect(parents[2].label).toMatch(/no longer in spec/);
  });

  it("finds the routes of a listener", () => {
    const gw = inventory.gateways![0];
    const a = route({ parentRefs: [{ name: "gw", namespace: "infra", sectionName: "http" }] });
    const b = route({ parentRefs: [{ name: "gw", namespace: "infra" }] });

    expect(routesOfListener([a, b], gw, gw.spec.listeners[0])).toEqual([a, b]);
    expect(routesOfListener([a, b], gw, gw.spec.listeners[1])).toEqual([b]);
  });
});

describe("snapshot adapters", () => {
  const snapshot: Snapshot = {
    items: {
      Gateway: inventory.gateways!,
      GatewayClass: inventory.gatewayClasses!,
      HTTPRoute: [route({ parentRefs: [{ name: "gw", namespace: "infra", sectionName: "http" }], rules: [{ backendRefs: [{ name: "web", port: 80 }] }] })],
      services: inventory.services!,
      namespaces: inventory.namespaces!,
      secrets: inventory.secrets!,
      ReferenceGrant: [],
    },
    notInstalled: ["TLSRoute"],
    errors: [{ what: "secrets", message: "forbidden", forbidden: true }],
    loadedAt: 0,
  };

  it("leaves unreadable lists unknown in the inventory", () => {
    const built = inventoryFromSnapshot(snapshot);

    expect(built.secrets).toBeUndefined();
    expect(built.services).toHaveLength(2);
  });

  it("feeds the map from the shared snapshot", () => {
    const topology = buildTopology(fromClusterSnapshot(snapshot));

    expect(topology.nodes.some((node) => node.id === "gateway:infra/gw")).toBe(true);
    expect(topology.edges.some((edge) => edge.from === "listener:Gateway:infra/gw:http" && edge.to === "route:HTTPRoute:apps/r")).toBe(true);
    expect(topology.edges.some((edge) => edge.to === "backend:Service:apps/web")).toBe(true);
  });
});
