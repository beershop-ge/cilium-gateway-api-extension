import type { Json, Path } from "../common/json";
import { type LabelSelector, selectorMatches } from "../common/selectors";
import { emptyItems, type Snapshot } from "../kube/snapshot";
import { gatewayGroup, isRouteKind } from "./features";
import { type ApiVersions, newReferenceGrant } from "./manifest";

export type IssueSeverity = "error" | "warning" | "info";

export interface GatewayIssue {
  readonly severity: IssueSeverity;
  readonly path: Path;
  readonly message: string;
  /** A ReferenceGrant that would make a cross-namespace reference allowed, offered as a fix. */
  readonly grant?: Json;
}

/** What references are checked against. A list that could not be read is `undefined`, and nothing is claimed about it. */
export interface Inventory {
  readonly services?: readonly Json[];
  readonly secrets?: readonly Json[];
  readonly namespaces?: readonly Json[];
  readonly gateways?: readonly Json[];
  readonly gatewayClasses?: readonly Json[];
  /** Empty when the ReferenceGrant CRD is not installed: then no cross-namespace reference is allowed. */
  readonly referenceGrants?: readonly Json[];
  readonly apiVersions?: ApiVersions;
}

const readable = (snapshot: Snapshot, what: string, title?: string) =>
  snapshot.errors.some((error) => error.what === what || (title !== undefined && error.what === title)) ? undefined : (snapshot.items[what] ?? emptyItems);

/** The inventory from a snapshot, leaving out (as unknown) every list the user could not read. */
export const inventoryFromSnapshot = (snapshot: Snapshot, apiVersions?: ApiVersions): Inventory => ({
  services: readable(snapshot, "services"),
  secrets: readable(snapshot, "secrets"),
  namespaces: readable(snapshot, "namespaces"),
  gateways: readable(snapshot, "Gateway", "Gateways"),
  gatewayClasses: readable(snapshot, "GatewayClass", "GatewayClasses"),
  referenceGrants: readable(snapshot, "ReferenceGrant", "ReferenceGrants"),
  apiVersions,
});

const findNamed = (items: readonly Json[] | undefined, name: string, namespace?: string) =>
  items?.find((item) => item?.metadata?.name === name && (namespace === undefined || item?.metadata?.namespace === namespace));

export const namespaceLabelsOf = (inventory: Inventory, namespace: string): Record<string, string> | undefined => {
  const found = findNamed(inventory.namespaces, namespace);

  return found ? { "kubernetes.io/metadata.name": namespace, ...(found.metadata?.labels ?? {}) } : undefined;
};

// ---------------------------------------------------------------------------------------------
// Hostnames

const validHostname = /^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export const hostnameError = (hostname: string): string | undefined => {
  if (hostname.length > 253) return "is longer than 253 characters";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) return "must be a DNS name, not an IP address";
  if (!validHostname.test(hostname)) return "is not a valid hostname (lowercase DNS labels, optionally starting with *.)";

  return undefined;
};

/**
 * Whether a listener hostname and a route hostname can both match a request, as the Gateway API
 * defines it: a wildcard `*.example.com` matches any name with at least one more label in front.
 */
export const hostnamesIntersect = (listenerHostname: string | undefined, routeHostname: string): boolean => {
  if (!listenerHostname) {
    return true;
  }

  const a = listenerHostname.toLowerCase();
  const b = routeHostname.toLowerCase();
  const wildA = a.startsWith("*.");
  const wildB = b.startsWith("*.");

  if (!wildA && !wildB) return a === b;
  if (wildA && !wildB) return b.endsWith(a.slice(1)) && b.length > a.length - 1;
  if (!wildA && wildB) return a.endsWith(b.slice(1)) && a.length > b.length - 1;

  return a.endsWith(b.slice(1)) || b.endsWith(a.slice(1));
};

/** Whether any of a route's hostnames can match the listener's (a route without hostnames matches every listener). */
export const routeHostnamesMatchListener = (listenerHostname: string | undefined, routeHostnames: readonly string[] | undefined) =>
  !routeHostnames || routeHostnames.length === 0 || routeHostnames.some((hostname) => hostnamesIntersect(listenerHostname, hostname));

// ---------------------------------------------------------------------------------------------
// Listeners

/** Protocols that may share a port: HTTPS and TLS are told apart by SNI, TCP and UDP are different transports. */
const compatibleProtocols = (a: string, b: string) => a === b || (["HTTPS", "TLS"].includes(a) && ["HTTPS", "TLS"].includes(b)) || (["TCP", "UDP"].includes(a) && ["TCP", "UDP"].includes(b));

const transportOf = (protocol: string) => (protocol === "UDP" ? "UDP" : "TCP");

/** Listener conflicts the Gateway API reports as `Conflicted`: duplicate names, protocol conflicts and hostname conflicts on a port. */
export const listenerConflicts = (listeners: readonly Json[], basePath: Path = ["spec", "listeners"]): GatewayIssue[] => {
  const issues: GatewayIssue[] = [];

  listeners.forEach((listener, index) => {
    for (let other = 0; other < index; other += 1) {
      const earlier = listeners[other];

      if (earlier?.name && earlier.name === listener?.name) {
        issues.push({ severity: "error", path: [...basePath, index, "name"], message: `Listener name "${listener.name}" is already used by listener ${other + 1}` });
      }

      if (earlier?.port !== listener?.port || listener?.port === undefined) {
        continue;
      }

      const protocol = String(listener.protocol ?? "");
      const earlierProtocol = String(earlier.protocol ?? "");

      if (!compatibleProtocols(protocol, earlierProtocol)) {
        issues.push({
          severity: "error",
          path: [...basePath, index, "protocol"],
          message: `Port ${listener.port}: ${protocol} conflicts with ${earlierProtocol} on listener "${earlier.name}" (ProtocolConflict)`,
        });
      } else if (transportOf(protocol) === transportOf(earlierProtocol) && (listener.hostname ?? "") === (earlier.hostname ?? "")) {
        issues.push({
          severity: "error",
          path: [...basePath, index, "hostname"],
          message: `Port ${listener.port}: listener "${listener.name}" and "${earlier.name}" both take ${listener.hostname ? `hostname ${listener.hostname}` : "every hostname"} (HostnameConflict)`,
        });
      }
    }
  });

  return issues;
};

/** The route kinds a listener admits when `allowedRoutes.kinds` is not set, by its protocol. */
export const defaultRouteKinds = (listener: Json): string[] => {
  switch (listener?.protocol) {
    case "HTTP":
    case "HTTPS":
      return ["HTTPRoute", "GRPCRoute"];
    case "TLS":
      return listener?.tls?.mode === "Terminate" ? ["TCPRoute"] : ["TLSRoute"];
    case "TCP":
      return ["TCPRoute"];
    case "UDP":
      return ["UDPRoute"];
    default:
      return [];
  }
};

export interface Admission {
  readonly admitted: boolean;
  readonly reason?: string;
}

/** Whether a listener admits routes of a kind from a namespace, by its `allowedRoutes`. */
export const listenerAdmits = (
  listener: Json,
  gatewayNamespace: string,
  route: { readonly kind: string; readonly group?: string; readonly namespace: string },
  routeNamespaceLabels: Readonly<Record<string, string>> | undefined,
): Admission => {
  const kinds = listener?.allowedRoutes?.kinds as Json[] | undefined;
  const allowedKinds = kinds && kinds.length > 0 ? kinds.filter((kind) => (kind.group ?? gatewayGroup) === (route.group ?? gatewayGroup)).map((kind) => kind.kind) : defaultRouteKinds(listener);

  if (!allowedKinds.includes(route.kind)) {
    return { admitted: false, reason: `Listener "${listener?.name}" (${listener?.protocol}) admits ${allowedKinds.join(", ") || "no route kinds"}, not ${route.kind}` };
  }

  const from = listener?.allowedRoutes?.namespaces?.from ?? "Same";

  if (from === "All") {
    return { admitted: true };
  }

  if (from === "Same") {
    return route.namespace === gatewayNamespace
      ? { admitted: true }
      : { admitted: false, reason: `Listener "${listener?.name}" only admits routes from its own namespace ${gatewayNamespace}` };
  }

  if (from === "Selector") {
    if (routeNamespaceLabels === undefined) {
      return { admitted: true, reason: `Namespace labels of ${route.namespace} could not be read; the selector of listener "${listener?.name}" was not checked` };
    }

    return selectorMatches(listener?.allowedRoutes?.namespaces?.selector as LabelSelector | undefined, routeNamespaceLabels)
      ? { admitted: true }
      : { admitted: false, reason: `Namespace ${route.namespace} does not match the namespace selector of listener "${listener?.name}"` };
  }

  return { admitted: false, reason: `Listener "${listener?.name}" has an unknown allowedRoutes.namespaces.from "${from}"` };
};

// ---------------------------------------------------------------------------------------------
// ReferenceGrants

export interface ReferenceFrom {
  readonly group: string;
  readonly kind: string;
  readonly namespace: string;
}

export interface ReferenceTo {
  readonly group: string;
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
}

/** Whether a ReferenceGrant in the target's namespace allows the reference. Same-namespace references need none. */
export const referenceAllowed = (grants: readonly Json[], from: ReferenceFrom, to: ReferenceTo): boolean =>
  from.namespace === to.namespace ||
  grants.some(
    (grant) =>
      grant?.metadata?.namespace === to.namespace &&
      ((grant.spec?.from ?? []) as Json[]).some((entry) => (entry.group ?? "") === from.group && entry.kind === from.kind && entry.namespace === from.namespace) &&
      ((grant.spec?.to ?? []) as Json[]).some((entry) => (entry.group ?? "") === to.group && entry.kind === to.kind && (!entry.name || entry.name === to.name)),
  );

const crossNamespaceIssue = (inventory: Inventory, path: Path, from: ReferenceFrom, to: ReferenceTo, what: string): GatewayIssue | undefined => {
  if (from.namespace === to.namespace || inventory.referenceGrants === undefined || referenceAllowed(inventory.referenceGrants, from, to)) {
    return undefined;
  }

  return {
    severity: "error",
    path,
    message: `${what} ${to.namespace}/${to.name} is in another namespace and no ReferenceGrant in ${to.namespace} allows ${from.kind}s from ${from.namespace} to refer to it (RefNotPermitted)`,
    grant: newReferenceGrant(inventory.apiVersions ?? {}, from, { group: to.group, kind: to.kind, namespace: to.namespace, name: to.name }),
  };
};

// ---------------------------------------------------------------------------------------------
// Resources

const namespaceIssue = (inventory: Inventory, namespace: string | undefined): GatewayIssue[] => {
  if (!namespace) {
    return [{ severity: "error", path: ["metadata", "namespace"], message: "A namespace is required" }];
  }

  return inventory.namespaces && !findNamed(inventory.namespaces, namespace)
    ? [{ severity: "error", path: ["metadata", "namespace"], message: `Namespace ${namespace} does not exist` }]
    : [];
};

const controllerNamePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/[A-Za-z0-9/\-._~%!$&'()*+,;=:]+$/;

export const validateGatewayClass = (gatewayClass: Json): GatewayIssue[] => {
  const issues: GatewayIssue[] = [];
  const controllerName = gatewayClass?.spec?.controllerName;

  if (!controllerName) {
    issues.push({ severity: "error", path: ["spec", "controllerName"], message: "A controller name is required" });
  } else if (!controllerNamePattern.test(controllerName)) {
    issues.push({ severity: "error", path: ["spec", "controllerName"], message: "must be a domain-prefixed path, such as io.cilium/gateway-controller" });
  }

  const parametersRef = gatewayClass?.spec?.parametersRef;

  if (parametersRef && (!parametersRef.kind || !parametersRef.name || parametersRef.group === undefined)) {
    issues.push({ severity: "error", path: ["spec", "parametersRef"], message: "parametersRef needs a group, a kind and a name" });
  }

  return issues;
};

const certificateIssues = (inventory: Inventory, gateway: Json, listener: Json, path: Path): GatewayIssue[] => {
  const issues: GatewayIssue[] = [];
  const gatewayNamespace = gateway.metadata?.namespace;
  const refs = (listener.tls?.certificateRefs ?? []) as Json[];

  refs.forEach((ref, index) => {
    const refPath = [...path, "tls", "certificateRefs", index];
    const kind = ref.kind ?? "Secret";
    const group = ref.group ?? "";
    const namespace = ref.namespace ?? gatewayNamespace;

    if (!ref.name) {
      issues.push({ severity: "error", path: refPath, message: "A certificate reference needs a name" });

      return;
    }

    if (kind !== "Secret" || group !== "") {
      issues.push({ severity: "warning", path: refPath, message: `Certificate ${kind} ${ref.name} is not a Secret; only implementations supporting it will resolve it` });

      return;
    }

    if (inventory.secrets) {
      const secret = findNamed(inventory.secrets, ref.name, namespace);

      if (!secret) {
        issues.push({ severity: "error", path: refPath, message: `Secret ${namespace}/${ref.name} does not exist (InvalidCertificateRef)` });
      } else if (secret.type && secret.type !== "kubernetes.io/tls") {
        issues.push({ severity: "warning", path: refPath, message: `Secret ${namespace}/${ref.name} is of type ${secret.type}, not kubernetes.io/tls` });
      } else if (Array.isArray(secret.keys) && !(secret.keys.includes("tls.crt") && secret.keys.includes("tls.key"))) {
        issues.push({ severity: "error", path: refPath, message: `Secret ${namespace}/${ref.name} lacks tls.crt or tls.key` });
      }
    } else {
      issues.push({ severity: "info", path: refPath, message: `Secrets could not be read, so ${namespace}/${ref.name} was not checked` });
    }

    const cross = crossNamespaceIssue(inventory, refPath, { group: gatewayGroup, kind: "Gateway", namespace: gatewayNamespace }, { group: "", kind: "Secret", namespace, name: ref.name }, "Secret");

    if (cross) issues.push(cross);
  });

  return issues;
};

export const validateGateway = (gateway: Json, inventory: Inventory): GatewayIssue[] => {
  const issues: GatewayIssue[] = [...namespaceIssue(inventory, gateway?.metadata?.namespace)];
  const className = gateway?.spec?.gatewayClassName;

  if (!className) {
    issues.push({ severity: "error", path: ["spec", "gatewayClassName"], message: "A GatewayClass is required" });
  } else if (inventory.gatewayClasses && !findNamed(inventory.gatewayClasses, className)) {
    issues.push({ severity: "error", path: ["spec", "gatewayClassName"], message: `GatewayClass ${className} does not exist` });
  }

  const listeners = (gateway?.spec?.listeners ?? []) as Json[];

  if (listeners.length === 0) {
    issues.push({ severity: "error", path: ["spec", "listeners"], message: "A Gateway needs at least one listener" });
  }

  listeners.forEach((listener, index) => {
    const path: Path = ["spec", "listeners", index];
    const protocol = listener?.protocol;

    if (!listener?.name) issues.push({ severity: "error", path: [...path, "name"], message: "A listener needs a name" });
    if (!protocol) issues.push({ severity: "error", path: [...path, "protocol"], message: "A listener needs a protocol" });

    if (!Number.isInteger(listener?.port) || listener.port < 1 || listener.port > 65535) {
      issues.push({ severity: "error", path: [...path, "port"], message: "The port must be a whole number from 1 to 65535" });
    }

    if (listener?.hostname) {
      const error = hostnameError(listener.hostname);

      if (error) issues.push({ severity: "error", path: [...path, "hostname"], message: `Hostname ${error}` });
      if (protocol === "TCP" || protocol === "UDP") issues.push({ severity: "error", path: [...path, "hostname"], message: `${protocol} listeners cannot have a hostname` });
    }

    if (protocol === "HTTPS" || protocol === "TLS") {
      const mode = listener?.tls?.mode ?? "Terminate";

      if (!listener?.tls) {
        issues.push({ severity: "error", path: [...path, "tls"], message: `${protocol} listeners need TLS settings` });
      } else if (protocol === "HTTPS" && mode !== "Terminate") {
        issues.push({ severity: "error", path: [...path, "tls", "mode"], message: "HTTPS listeners terminate TLS; use a TLS listener for passthrough" });
      } else if (mode === "Terminate" && ((listener.tls.certificateRefs ?? []) as Json[]).length === 0 && !listener.tls.options) {
        issues.push({ severity: "error", path: [...path, "tls", "certificateRefs"], message: "Terminating TLS needs at least one certificate Secret" });
      } else if (mode === "Passthrough" && ((listener.tls.certificateRefs ?? []) as Json[]).length > 0) {
        issues.push({ severity: "error", path: [...path, "tls", "certificateRefs"], message: "Passthrough listeners cannot have certificates: the backend terminates TLS" });
      }

      issues.push(...certificateIssues(inventory, gateway, listener, path));
    } else if (listener?.tls) {
      issues.push({ severity: "error", path: [...path, "tls"], message: `${protocol} listeners cannot have TLS settings` });
    }

    const from = listener?.allowedRoutes?.namespaces?.from;

    if (from === "Selector" && !listener.allowedRoutes.namespaces.selector) {
      issues.push({ severity: "error", path: [...path, "allowedRoutes", "namespaces", "selector"], message: "Selector needs a namespace selector" });
    }

    const kinds = (listener?.allowedRoutes?.kinds ?? []) as Json[];
    const compatible = defaultRouteKinds({ ...listener, allowedRoutes: undefined });

    kinds.forEach((kind, kindIndex) => {
      if ((kind.group ?? gatewayGroup) === gatewayGroup && !compatible.includes(kind.kind)) {
        issues.push({ severity: "error", path: [...path, "allowedRoutes", "kinds", kindIndex], message: `A ${protocol} listener cannot serve ${kind.kind} (InvalidRouteKinds)` });
      }
    });
  });

  issues.push(...listenerConflicts(listeners));

  ((gateway?.spec?.addresses ?? []) as Json[]).forEach((address, index) => {
    if (!address?.value) issues.push({ severity: "error", path: ["spec", "addresses", index, "value"], message: "An address needs a value" });
  });

  return issues;
};

/** The listeners of a Gateway a parentRef selects: by sectionName and port, or all. */
export const listenersSelectedBy = (gateway: Json, parentRef: Json): Json[] =>
  ((gateway?.spec?.listeners ?? []) as Json[]).filter((listener) => (!parentRef?.sectionName || listener.name === parentRef.sectionName) && (parentRef?.port === undefined || listener.port === parentRef.port));

const parentRefIssues = (inventory: Inventory, route: Json): GatewayIssue[] => {
  const issues: GatewayIssue[] = [];
  const namespace = route?.metadata?.namespace;
  const refs = (route?.spec?.parentRefs ?? []) as Json[];

  if (refs.length === 0) {
    issues.push({ severity: "warning", path: ["spec", "parentRefs"], message: "The route is not attached to any Gateway, so it carries no traffic" });
  }

  refs.forEach((ref, index) => {
    const path: Path = ["spec", "parentRefs", index];
    const kind = ref?.kind ?? "Gateway";

    if (!ref?.name) {
      issues.push({ severity: "error", path, message: "A parent reference needs a name" });

      return;
    }

    if (kind !== "Gateway" || (ref.group ?? gatewayGroup) !== gatewayGroup) {
      issues.push({ severity: "info", path, message: `Parent ${kind} ${ref.name} is not a Gateway and is not checked here` });

      return;
    }

    const gatewayNamespace = ref.namespace ?? namespace;

    if (!inventory.gateways) {
      issues.push({ severity: "info", path, message: "Gateways could not be read, so the parent was not checked" });

      return;
    }

    const gateway = findNamed(inventory.gateways, ref.name, gatewayNamespace);

    if (!gateway) {
      issues.push({ severity: "error", path, message: `Gateway ${gatewayNamespace}/${ref.name} does not exist` });

      return;
    }

    const listeners = (gateway.spec?.listeners ?? []) as Json[];

    if (ref.sectionName && !listeners.some((listener) => listener.name === ref.sectionName)) {
      issues.push({ severity: "error", path: [...path, "sectionName"], message: `Gateway ${gatewayNamespace}/${ref.name} has no listener named "${ref.sectionName}" (NoMatchingParent)` });

      return;
    }

    const selected = listenersSelectedBy(gateway, ref);

    if (selected.length === 0) {
      issues.push({ severity: "error", path: [...path, "port"], message: `No listener of Gateway ${gatewayNamespace}/${ref.name} matches ${ref.sectionName ? `"${ref.sectionName}" on ` : ""}port ${ref.port} (NoMatchingParent)` });

      return;
    }

    const labels = namespaceLabelsOf(inventory, namespace);
    const admissions = selected.map((listener) => ({ listener, admission: listenerAdmits(listener, gatewayNamespace, { kind: route.kind, namespace }, labels) }));
    const admitting = admissions.filter(({ admission }) => admission.admitted);

    if (admitting.length === 0) {
      issues.push({ severity: "error", path, message: `Not admitted (NotAllowedByListeners): ${admissions.map(({ admission }) => admission.reason).join("; ")}` });

      return;
    }

    for (const { admission } of admitting) {
      if (admission.reason) issues.push({ severity: "info", path, message: admission.reason });
    }

    const hostnames = route.spec?.hostnames as string[] | undefined;

    if (hostnames && hostnames.length > 0 && !admitting.some(({ listener }) => routeHostnamesMatchListener(listener.hostname, hostnames))) {
      issues.push({
        severity: "error",
        path: ["spec", "hostnames"],
        message: `None of the hostnames ${hostnames.join(", ")} intersects the hostname of the admitting listeners of ${gatewayNamespace}/${ref.name} (${admitting.map(({ listener }) => `${listener.name}: ${listener.hostname ?? "any"}`).join(", ")}) (NoMatchingListenerHostname)`,
      });
    }
  });

  return issues;
};

const backendRefIssues = (inventory: Inventory, route: Json, backend: Json, path: Path): GatewayIssue[] => {
  const issues: GatewayIssue[] = [];
  const namespace = route?.metadata?.namespace;
  const kind = backend?.kind ?? "Service";
  const group = backend?.group ?? "";
  const backendNamespace = backend?.namespace ?? namespace;

  if (!backend?.name) {
    return [{ severity: "error", path: [...path, "name"], message: "A backend needs a Service" }];
  }

  if (backend.weight !== undefined && (!Number.isInteger(backend.weight) || backend.weight < 0 || backend.weight > 1_000_000)) {
    issues.push({ severity: "error", path: [...path, "weight"], message: "The weight must be a whole number from 0 to 1000000" });
  }

  if (kind === "Service" && group === "") {
    if (backend.port === undefined) {
      issues.push({ severity: "error", path: [...path, "port"], message: `A port is required for Service ${backend.name}` });
    }

    if (inventory.services) {
      const service = findNamed(inventory.services, backend.name, backendNamespace);

      if (!service) {
        issues.push({ severity: "error", path: [...path, "name"], message: `Service ${backendNamespace}/${backend.name} does not exist (BackendNotFound)` });
      } else if (backend.port !== undefined && !((service.spec?.ports ?? []) as Json[]).some((port) => port.port === backend.port)) {
        issues.push({
          severity: "error",
          path: [...path, "port"],
          message: `Service ${backendNamespace}/${backend.name} has no port ${backend.port} (it has ${((service.spec?.ports ?? []) as Json[]).map((port) => port.port).join(", ") || "none"})`,
        });
      } else if (route.kind === "UDPRoute" && backend.port !== undefined && ((service.spec?.ports ?? []) as Json[]).find((port) => port.port === backend.port)?.protocol !== "UDP") {
        issues.push({ severity: "warning", path: [...path, "port"], message: `Port ${backend.port} of Service ${backend.name} is not a UDP port` });
      }
    } else {
      issues.push({ severity: "info", path, message: "Services could not be read, so the backend was not checked" });
    }
  } else {
    issues.push({ severity: "info", path, message: `Backend ${kind} ${backend.name} is not a Service and is not checked here` });
  }

  const cross = crossNamespaceIssue(inventory, path, { group: gatewayGroup, kind: route.kind, namespace }, { group, kind, namespace: backendNamespace, name: backend.name }, kind);

  if (cross) issues.push(cross);

  return issues;
};

export const validateRoute = (route: Json, inventory: Inventory): GatewayIssue[] => {
  const issues: GatewayIssue[] = [...namespaceIssue(inventory, route?.metadata?.namespace), ...parentRefIssues(inventory, route)];
  const kind = route?.kind;

  ((route?.spec?.hostnames ?? []) as string[]).forEach((hostname, index) => {
    const error = hostnameError(hostname);

    if (error) issues.push({ severity: "error", path: ["spec", "hostnames", index], message: `Hostname ${hostname} ${error}` });
  });

  const rules = (route?.spec?.rules ?? []) as Json[];

  if (rules.length === 0 && kind !== "HTTPRoute" && kind !== "GRPCRoute") {
    issues.push({ severity: "error", path: ["spec", "rules"], message: "The route needs at least one rule" });
  }

  rules.forEach((rule, ruleIndex) => {
    const rulePath: Path = ["spec", "rules", ruleIndex];
    const backends = (rule?.backendRefs ?? []) as Json[];
    const filters = (rule?.filters ?? []) as Json[];
    const types = filters.map((filter) => filter?.type);
    const redirects = types.includes("RequestRedirect");

    backends.forEach((backend, index) => issues.push(...backendRefIssues(inventory, route, backend, [...rulePath, "backendRefs", index])));

    if (backends.length > 1 && backends.every((backend) => backend.weight === 0)) {
      issues.push({ severity: "warning", path: [...rulePath, "backendRefs"], message: "Every backend has weight 0, so requests matching this rule get an error response" });
    }

    if (backends.length === 0 && !redirects && (kind === "HTTPRoute" || kind === "GRPCRoute")) {
      issues.push({ severity: "warning", path: [...rulePath, "backendRefs"], message: "The rule has no backend, so matching requests get a 500 (or 404) response" });
    }

    if (backends.length === 0 && (kind === "TLSRoute" || kind === "TCPRoute" || kind === "UDPRoute")) {
      issues.push({ severity: "error", path: [...rulePath, "backendRefs"], message: "The rule needs at least one backend" });
    }

    if (redirects && types.includes("URLRewrite")) {
      issues.push({ severity: "error", path: [...rulePath, "filters"], message: "A rule cannot both redirect and rewrite" });
    }

    if (redirects && backends.length > 0) {
      issues.push({ severity: "error", path: [...rulePath, "backendRefs"], message: "A redirecting rule cannot also have backends" });
    }

    for (const type of ["RequestRedirect", "URLRewrite", "RequestHeaderModifier", "ResponseHeaderModifier"]) {
      if (types.filter((candidate) => candidate === type).length > 1) {
        issues.push({ severity: "error", path: [...rulePath, "filters"], message: `${type} may appear only once in a rule` });
      }
    }

    filters.forEach((filter, index) => {
      if (filter?.type === "RequestMirror") {
        issues.push(...backendRefIssues(inventory, route, filter.requestMirror?.backendRef ?? {}, [...rulePath, "filters", index, "requestMirror", "backendRef"]));
      }

      if (filter?.type === "URLRewrite" || filter?.type === "RequestRedirect") {
        const pathModifier = filter.urlRewrite?.path ?? filter.requestRedirect?.path;

        if (pathModifier?.type === "ReplacePrefixMatch" && !((rule.matches ?? []) as Json[]).every((match) => (match.path?.type ?? "PathPrefix") === "PathPrefix")) {
          issues.push({ severity: "error", path: [...rulePath, "filters", index], message: "ReplacePrefixMatch needs every match of the rule to be a PathPrefix match" });
        }
      }
    });

    ((rule?.matches ?? []) as Json[]).forEach((match, index) => {
      const value = match?.path?.value;

      if (kind === "HTTPRoute" && value !== undefined && match.path.type !== "RegularExpression" && !String(value).startsWith("/")) {
        issues.push({ severity: "error", path: [...rulePath, "matches", index, "path", "value"], message: "A path must start with /" });
      }

      if (kind === "HTTPRoute" && match?.path?.type === "RegularExpression") {
        try {
          new RegExp(String(value ?? ""));
        } catch {
          issues.push({ severity: "error", path: [...rulePath, "matches", index, "path", "value"], message: "The regular expression does not parse" });
        }
      }

      if (kind === "GRPCRoute" && match?.method && !match.method.service && !match.method.method) {
        issues.push({ severity: "error", path: [...rulePath, "matches", index, "method"], message: "A method match needs a service, a method or both" });
      }
    });
  });

  return issues;
};

export const validateReferenceGrant = (grant: Json, inventory: Inventory): GatewayIssue[] => {
  const issues: GatewayIssue[] = [...namespaceIssue(inventory, grant?.metadata?.namespace)];
  const from = (grant?.spec?.from ?? []) as Json[];
  const to = (grant?.spec?.to ?? []) as Json[];

  if (from.length === 0) issues.push({ severity: "error", path: ["spec", "from"], message: "Add at least one source the grant allows" });
  if (to.length === 0) issues.push({ severity: "error", path: ["spec", "to"], message: "Add at least one target the grant allows" });

  from.forEach((entry, index) => {
    if (!entry?.kind) issues.push({ severity: "error", path: ["spec", "from", index, "kind"], message: "A kind is required" });

    if (!entry?.namespace) {
      issues.push({ severity: "error", path: ["spec", "from", index, "namespace"], message: "A namespace is required" });
    } else if (inventory.namespaces && !findNamed(inventory.namespaces, entry.namespace)) {
      issues.push({ severity: "warning", path: ["spec", "from", index, "namespace"], message: `Namespace ${entry.namespace} does not exist (yet)` });
    }

    if (entry?.namespace && entry.namespace === grant?.metadata?.namespace) {
      issues.push({ severity: "info", path: ["spec", "from", index, "namespace"], message: "References within one namespace need no grant" });
    }
  });

  to.forEach((entry, index) => {
    if (!entry?.kind) issues.push({ severity: "error", path: ["spec", "to", index, "kind"], message: "A kind is required" });

    if (entry?.name && entry.kind === "Service" && (entry.group ?? "") === "" && inventory.services && !findNamed(inventory.services, entry.name, grant?.metadata?.namespace)) {
      issues.push({ severity: "warning", path: ["spec", "to", index, "name"], message: `Service ${grant.metadata.namespace}/${entry.name} does not exist` });
    }

    if (entry?.name && entry.kind === "Secret" && (entry.group ?? "") === "" && inventory.secrets && !findNamed(inventory.secrets, entry.name, grant?.metadata?.namespace)) {
      issues.push({ severity: "warning", path: ["spec", "to", index, "name"], message: `Secret ${grant.metadata.namespace}/${entry.name} does not exist` });
    }
  });

  return issues;
};

/** Checks the references of any Gateway API resource the designer builds. */
export const validateGatewayResource = (resource: Json, inventory: Inventory): GatewayIssue[] => {
  const kind = String(resource?.kind ?? "");

  if (kind === "GatewayClass") return validateGatewayClass(resource);
  if (kind === "Gateway") return validateGateway(resource, inventory);
  if (kind === "ReferenceGrant") return validateReferenceGrant(resource, inventory);
  if (isRouteKind(kind)) return validateRoute(resource, inventory);

  return [];
};

/** The ReferenceGrants the issues offer, without duplicates. */
export const suggestedGrants = (issues: readonly GatewayIssue[]): Json[] => {
  const seen = new Set<string>();

  return issues.flatMap((issue) => {
    if (!issue.grant) return [];

    const key = JSON.stringify(issue.grant);

    if (seen.has(key)) return [];

    seen.add(key);

    return [issue.grant];
  });
};

const startsWith = (path: Path, prefix: Path) => prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

/** Issues at a path or below it, for showing them beside the part of the form they concern. */
export const issuesUnder = (issues: readonly GatewayIssue[], prefix: Path, { exact = false } = {}): GatewayIssue[] =>
  issues.filter((issue) => (exact ? issue.path.length === prefix.length && startsWith(issue.path, prefix) : startsWith(issue.path, prefix)));
